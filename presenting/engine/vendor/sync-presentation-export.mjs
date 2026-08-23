#!/usr/bin/env node
/**
 * Fetches the vendored `presentation-export` runtime (proprietary, per the
 * deliberately-confirmed exception — see hypatia-backend/docs/adr/ and the
 * Phase 5 plan notes) and its Chromium dependency, into
 * presenting/engine/vendor/presentation-export/.
 *
 * Modeled on presenton's own electron/scripts/{sync-export-runtime.cjs,
 * prepare-export-chromium.cjs} — NOT its Dockerfile, which is Linux-only and
 * misses per-platform asset resolution entirely (see the Phase 5 plan notes
 * for why that distinction matters for a cross-platform Tauri app).
 *
 * Usage: node vendor/sync-presentation-export.mjs [--force]
 *
 * What this does NOT do (deliberately, for now — see export_runtime_service.py):
 *   - Apply presenton's `networkidle0` -> `domcontentloaded` patch: confirmed
 *     by inspecting the actual downloaded v0.4.8 build that it already uses
 *     `waitUntil:"load"` for HTML-to-image rendering, so that patch's target
 *     string doesn't exist in this build and isn't needed.
 *   - The macOS App-Store codesign/framework-symlink normalization from
 *     presenton's prepare-export-chromium.cjs — that's Electron-packaging-
 *     specific hardening; Tauri's own bundler has different requirements,
 *     revisit in Phase 9 if actually needed.
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = __dirname;
const exportDir = path.join(vendorRoot, "presentation-export");
const pyDir = path.join(exportDir, "py");
const cacheDir = path.join(vendorRoot, ".cache", "export-runtime");

// Pinned to match presenton's own electron/package.json exactly — same
// release, same Chromium build ids, so behavior matches their tested combo.
const EXPORT_VERSION = "v0.4.8";
const EXPORT_REPO_BASE = "https://github.com/presenton/presenton-export/releases/download";
const CHROMIUM_BUILD_IDS = {
  "darwin-arm64": "1625085",
  "darwin-x64": "1625072",
};
const CHROME_BUILD_ID = "149.0.7827.196"; // linux/win32 — Chrome for Testing, not Chromium

const forceDownload = process.argv.includes("--force");

function getPlatformAssetName() {
  const platformArch = `${process.platform}-${process.arch}`;
  if (platformArch === "linux-arm64") return "export-Linux-ARM64.zip";
  if (platformArch === "linux-x64") return "export-Linux-X64.zip";
  if (platformArch === "darwin-arm64") return "export-macOS-ARM64.zip";
  if (platformArch === "darwin-x64") return "export-macOS-X64.zip";
  if (platformArch === "win32-x64") return "export-Windows-X64.zip";
  throw new Error(`Unsupported export runtime platform: ${platformArch}`);
}

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

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: "inherit" });
    return;
  }
  execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
}

async function syncExportRuntime() {
  const indexPath = path.join(exportDir, "index.js");
  const converterGlob = fs.existsSync(pyDir) ? fs.readdirSync(pyDir) : [];
  const hasConverter = converterGlob.some((name) => name.startsWith("convert"));

  if (!forceDownload && fs.existsSync(indexPath) && hasConverter) {
    console.log("[sync] presentation-export runtime already present, skipping (use --force to re-fetch).");
  } else {
    const assetName = getPlatformAssetName();
    const url = `${EXPORT_REPO_BASE}/${EXPORT_VERSION}/${assetName}`;
    const zipPath = path.join(cacheDir, assetName);

    console.log(`[sync] Downloading ${url}`);
    await downloadFile(url, zipPath);

    const extractDir = path.join(cacheDir, `extract-${Date.now()}`);
    console.log(`[sync] Extracting to ${extractDir}`);
    unzip(zipPath, extractDir);

    fs.mkdirSync(exportDir, { recursive: true });
    fs.mkdirSync(pyDir, { recursive: true });
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      const from = path.join(extractDir, entry.name);
      if (entry.name.startsWith("convert")) {
        const to = path.join(pyDir, entry.name);
        fs.cpSync(from, to);
        if (process.platform !== "win32") fs.chmodSync(to, 0o755);
      } else {
        fs.cpSync(from, path.join(exportDir, entry.name), { recursive: true });
      }
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    console.log("[sync] presentation-export runtime installed.");
  }

  // `sharp` is an external peer dependency of index.js (not bundled in the
  // minified build) — confirmed by hands-on testing (MODULE_NOT_FOUND
  // without it), not documented anywhere in presenton's own scripts.
  if (forceDownload || !fs.existsSync(path.join(exportDir, "node_modules", "sharp"))) {
    console.log("[sync] Installing sharp (required by index.js, not bundled)...");
    execSync("npm install --no-audit --no-fund sharp", { cwd: exportDir, stdio: "inherit" });
  }
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
  await syncExportRuntime();

  // @puppeteer/browsers is a build-time-only tool for fetching Chromium —
  // installed at this script's own level (vendor/), not inside
  // presentation-export/ (that dir's node_modules is index.js's runtime
  // dependency set, sharp only; dynamic import() resolves relative to this
  // file's own directory, so it must live here to be importable below).
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
