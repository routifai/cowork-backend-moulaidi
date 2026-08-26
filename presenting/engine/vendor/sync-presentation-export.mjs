#!/usr/bin/env node
/**
 * Installs the vendored `@presenton/export-core` package (real npm package,
 * distributed as a GitHub Release tarball rather than through the npm
 * registry — see https://github.com/presenton/presenton-export) into
 * presenting/engine/vendor/presentation-export/, plus its Chromium
 * dependency.
 *
 * This replaces an earlier vendored runtime: presenton's old Electron-era
 * export pipeline (pinned at v0.4.8) shelled out to a frozen Python binary
 * (PyInstaller, `py/convert-<platform>-<arch>`) via a subprocess/task-file
 * protocol. Presenton has since rewritten that pipeline as this pure
 * TypeScript/JS package (confirmed via its own package.json: "Python is not
 * required") with a plain typed `runTask()` function export — no python, no
 * subprocess protocol, just an in-process import. v0.4.8 was confirmed to be
 * the last release in that old lineage (no newer platform-zip release
 * exists); this package is the intended replacement, not a parallel option.
 *
 * The "opensource" edition (this script installs) omits the "quality" knob
 * on `export`/`html-to-any` tasks (always low-quality for those two task
 * types) but was empirically confirmed (via a real rich-shape probe against
 * both the old and new binaries, comparing python-pptx-inspected output) to
 * fully support `pptx-from-json` — the only task type this codebase uses —
 * including fill/stroke/shadow/bold/underline. One real limitation carried
 * over unchanged from the old binary: `autoshape.border_radius` is read by
 * the package's own conversion code but does not actually render a rounded
 * shape in the output .pptx in either edition — smart-dom-extractor.ts
 * still treats a rounded background as unsupported (raster fallback) for
 * that reason, not because this vendoring is incomplete.
 *
 * Usage: node vendor/sync-presentation-export.mjs [--force]
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = __dirname;
const exportDir = path.join(vendorRoot, "presentation-export");
const cacheDir = path.join(vendorRoot, ".cache", "export-runtime");

// Pinned to a specific @presenton/export-core opensource release. Bump
// deliberately (not "latest") so behavior only changes when this file changes.
const EXPORT_CORE_VERSION = "1.0.18";
const EXPORT_CORE_TARBALL_URL = `https://github.com/presenton/presenton-export/releases/download/v${EXPORT_CORE_VERSION}/presenton-export-core-opensource-${EXPORT_CORE_VERSION}.tgz`;
const CHROMIUM_BUILD_IDS = {
  "darwin-arm64": "1625085",
  "darwin-x64": "1625072",
};
const CHROME_BUILD_ID = "149.0.7827.196"; // linux/win32 — Chrome for Testing, not Chromium

const forceDownload = process.argv.includes("--force");

function downloadFile(url, outputPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "hypatia-presenting-engine-sync" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects <= 0) return reject(new Error(`Too many redirects: ${url}`));
        downloadFile(res.headers.location, outputPath, redirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Failed to download ${url}. HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const fileStream = fs.createWriteStream(outputPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(resolve));
      fileStream.on("error", reject);
    }).on("error", reject);
  });
}

async function syncExportCore() {
  const installedPkgJson = path.join(exportDir, "node_modules", "@presenton", "export-core", "package.json");
  if (!forceDownload && fs.existsSync(installedPkgJson)) {
    const installed = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
    if (installed.version === EXPORT_CORE_VERSION) {
      console.log(`[sync] @presenton/export-core@${EXPORT_CORE_VERSION} already installed, skipping (use --force to reinstall).`);
      return;
    }
  }

  const tarballPath = path.join(cacheDir, `export-core-opensource-${EXPORT_CORE_VERSION}.tgz`);
  if (forceDownload || !fs.existsSync(tarballPath)) {
    console.log(`[sync] Downloading ${EXPORT_CORE_TARBALL_URL}`);
    await downloadFile(EXPORT_CORE_TARBALL_URL, tarballPath);
  }

  fs.mkdirSync(exportDir, { recursive: true });
  const pkgJsonPath = path.join(exportDir, "package.json");
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify(
      {
        name: "hypatia-presenting-engine-presentation-export-vendor",
        private: true,
        type: "module",
        description: "Vendored @presenton/export-core (real npm package, GitHub-Release-tarball distributed) — see sync-presentation-export.mjs for why. node_modules/ is not committed, see .gitignore.",
        dependencies: {
          "@presenton/export-core": `file:${tarballPath}`,
        },
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`[sync] Installing @presenton/export-core@${EXPORT_CORE_VERSION}...`);
  execSync("npm install --no-audit --no-fund", {
    cwd: exportDir,
    stdio: "inherit",
    // The package's own `puppeteer` dependency would otherwise try to
    // download its own managed Chromium on install — redundant, since we
    // vendor and pin our own Chromium build below and pass its
    // executablePath into every runTask() call explicitly.
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
  });
  console.log("[sync] @presenton/export-core installed.");
}

async function syncChromium() {
  const { Browser, install, computeExecutablePath, detectBrowserPlatform } = await import("@puppeteer/browsers");
  const chromiumCacheDir = path.join(exportDir, "chromium-cache");
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Unsupported platform for bundled Chromium: ${process.platform}-${process.arch}`);

  const isMac = process.platform === "darwin";
  const browser = isMac ? Browser.CHROMIUM : Browser.CHROME;
  const buildId = isMac ? CHROMIUM_BUILD_IDS[`${process.platform}-${process.arch}`] : CHROME_BUILD_ID;
  if (!buildId) throw new Error(`No pinned Chromium build id for ${process.platform}-${process.arch}`);

  const executablePath = computeExecutablePath({ browser, buildId, cacheDir: chromiumCacheDir, platform });
  if (!forceDownload && fs.existsSync(executablePath)) {
    console.log(`[sync] Chromium already present: ${executablePath}`);
    return;
  }

  console.log(`[sync] Downloading ${browser} ${buildId}...`);
  let lastPercent = -1;
  await install({
    browser, buildId, cacheDir: chromiumCacheDir, platform,
    downloadProgressCallback(downloaded, total) {
      if (total <= 0) return;
      const percent = Math.floor((downloaded / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        process.stdout.write(`\r[sync] Chromium download: ${percent}%`);
      }
    },
  });
  process.stdout.write("\n");
  console.log(`[sync] Chromium installed: ${executablePath}`);
}

async function main() {
  await syncExportCore();

  // @puppeteer/browsers is a build-time-only tool for fetching Chromium —
  // installed at this script's own level (vendor/), not inside
  // presentation-export/ (that dir's node_modules is @presenton/export-core's
  // own runtime dependency set). Dynamic import() below resolves relative to
  // this file's own directory, so it must live here to be importable.
  const hasPuppeteerBrowsers = fs.existsSync(path.join(vendorRoot, "node_modules", "@puppeteer", "browsers"));
  if (!hasPuppeteerBrowsers) {
    console.log("[sync] Installing @puppeteer/browsers...");
    if (!fs.existsSync(path.join(vendorRoot, "package.json"))) {
      fs.writeFileSync(
        path.join(vendorRoot, "package.json"),
        JSON.stringify({ name: "hypatia-presenting-engine-vendor-tools", private: true, type: "module" }, null, 2) + "\n",
      );
    }
    execSync("npm install --no-audit --no-fund @puppeteer/browsers", { cwd: vendorRoot, stdio: "inherit" });
  }

  await syncChromium();
  console.log("[sync] Done.");
}

main().catch((error) => {
  console.error(`[sync] ${error.message}`);
  process.exit(1);
});
