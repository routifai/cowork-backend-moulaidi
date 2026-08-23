/**
 * In-memory template store.
 * Port of presenting/engine/services/template_store.py
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "../paths.js";
import { resolveTemplateImageAssets } from "./template-asset-resolution.js";

const TEMPLATES_DIR = templatesDir();

const _cache = new Map<string, Record<string, unknown>>();

function loadTemplates(): void {
  if (!existsSync(TEMPLATES_DIR)) return;
  for (const name of readdirSync(TEMPLATES_DIR)) {
    const jsonPath = join(TEMPLATES_DIR, name, "template.json");
    if (!existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      // Bake every "static/..."/"/static/..." image reference into a base64
      // data URI once, at load time — nothing in the shipped app actually
      // serves those paths (see template-asset-resolution.ts).
      const resolved = resolveTemplateImageAssets(data, join(TEMPLATES_DIR, name, "static"));
      _cache.set(name, resolved);
    } catch { /* skip malformed templates */ }
  }
}

loadTemplates();

export function getTemplate(name: string): Record<string, unknown> | null {
  return _cache.get(name) ?? null;
}

export function listTemplateNames(): string[] {
  return [..._cache.keys()];
}
