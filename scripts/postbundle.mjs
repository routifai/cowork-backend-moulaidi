// Post-processes dist/bundle.cjs (produced by `pnpm run bundle`) so the
// artifact is complete and self-contained on its own — no consumer of this
// repo's build output should need to know esbuild/CJS internals.
//
// Two patches, both required for the bundle to actually run under plain
// `node dist/bundle.cjs`:
//
//   1. `import.meta.url` shim fixup — esbuild's CJS output shims
//      `import.meta.url` as an empty object assigned at runtime; unpatched,
//      any code that reads `.url` off it (fileURLToPath, etc.) gets
//      `undefined` and throws. Two shapes occur:
//        (a) top-level: `var import_meta10 = {};`            (our own source)
//        (b) inside __esm() wrappers, split: declaration `var ..., import_meta, ...;`
//            then assignment `import_meta = {};` with NO `var` (pi-SDK modules).
//      Matching the assignment (no `var ` prefix) catches both.
//   2. Inlines `@earendil-works/pi-coding-agent`'s package.json — the bundled
//      code reads its own package.json at runtime (name, version,
//      piConfig.configDir), which won't exist once this file is copied
//      somewhere without node_modules/.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundlePath = join(root, "dist", "bundle.cjs");

console.log("[postbundle] Patching import_meta.url...");
let code = readFileSync(bundlePath, "utf-8");
const importMetaRe = /(import_meta\d*) = \{\};/g;
const patchedCount = (code.match(importMetaRe) || []).length;
code = code.replace(importMetaRe, '$1 = { url: require("url").pathToFileURL(__filename).href };');
console.log(`[postbundle]   patched ${patchedCount} import_meta.url shims`);

console.log("[postbundle] Inlining pi-coding-agent package.json...");
const piPkgPath = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const piPkg = JSON.parse(readFileSync(piPkgPath, "utf-8"));
const inlinedPkg = JSON.stringify({ name: piPkg.name, version: piPkg.version, piConfig: piPkg.piConfig });
code = code.replace(
	'var pkg = JSON.parse((0, import_fs.readFileSync)(getPackageJsonPath(), "utf-8"));',
	`var pkg = ${inlinedPkg};`,
);

writeFileSync(bundlePath, code, "utf-8");
console.log(`[postbundle] Done (${(code.length / 1024 / 1024).toFixed(1)} MB)`);
