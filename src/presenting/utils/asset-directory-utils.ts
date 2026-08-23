/**
 * Filesystem locations for generated assets.
 * Port of presenting/engine/services/asset_directory_utils.py — same env var
 * names so existing configs carry over. No HTTP URL rewriting (no server here);
 * all URLs are absolute filesystem paths the frontend can load directly.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import os from "os";
import { presentingEngineRoot } from "../paths.js";

const APP_DATA_ENV_VAR = "PRESENTING_APP_DATA_DIRECTORY";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function guessMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Read a file and return it as a `data:` URI, or null if it doesn't exist. */
export function fileToDataUri(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const data = readFileSync(filePath);
  return `data:${guessMimeType(filePath)};base64,${data.toString("base64")}`;
}

/** Resolve an app-wide "/static/..." reference (e.g. the shared placeholder images) to its real file path under presenting/engine/static/. */
export function appStaticAssetPath(staticRef: string): string {
  const rel = staticRef.startsWith("/static/") ? staticRef.slice("/static/".length) : staticRef.slice("static/".length);
  return join(presentingEngineRoot(), "static", rel);
}

export function getAppDataDirectory(): string {
  const configured = process.env[APP_DATA_ENV_VAR];
  if (configured) return configured;
  return join(os.homedir(), ".hypatia-presenting-engine", "app_data");
}

function ownedDirectory(rootName: string): string {
  const dir = join(getAppDataDirectory(), rootName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getImagesDirectory(): string {
  return ownedDirectory("images");
}

export function getExportsDirectory(): string {
  return ownedDirectory("exports");
}

export function getUploadsDirectory(): string {
  return ownedDirectory("uploads");
}

export function normalizeSlideAssetUrl(pathOrUrl: string): string {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return pathOrUrl;
  const s = pathOrUrl.trim();
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:") || s.startsWith("blob:")) {
    return s;
  }
  return filesystemImagePathToAppDataUrl(s);
}

/**
 * Turn a local image reference into something the frontend can actually
 * load. Nothing in the shipped app serves raw filesystem paths or
 * "/static/..." references as URLs (no Tauri custom protocol, no
 * assetProtocol scope, no convertFileSrc use — see
 * template-asset-resolution.ts for the full story), so this reads the file
 * and returns a base64 data: URI. Falls back to the resolved path string
 * (unloadable, but at least visible in logs/devtools) if the file can't be
 * found, rather than throwing and failing the whole slide.
 */
export function filesystemImagePathToAppDataUrl(pathOrUrl: string): string {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return pathOrUrl;
  const s = pathOrUrl.trim();
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:") || s.startsWith("blob:")) {
    return s;
  }
  const filePath = s.startsWith("/static/") ? appStaticAssetPath(s) : resolve(s);
  return fileToDataUri(filePath) ?? filePath;
}

export function resolveAppPathToFilesystem(pathOrUrl: string): string | null {
  if (!pathOrUrl || typeof pathOrUrl !== "string" || !pathOrUrl.trim()) return null;
  const s = pathOrUrl.trim();
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:") || s.startsWith("blob:")) {
    return null;
  }
  const resolved = resolve(s);
  return existsSync(resolved) ? resolved : null;
}

export function resolveImagePathToFilesystem(pathOrUrl: string): string | null {
  return resolveAppPathToFilesystem(pathOrUrl);
}
