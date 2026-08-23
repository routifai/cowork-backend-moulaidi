/**
 * Semantic icon search over the bundled Phosphor SVG library.
 *
 * Port of presenting/engine/services/icon_finder_service.py. The Python engine
 * used fastembed + a pre-built vectorstore. Here we implement two-tier search:
 *
 * 1. Keyword scoring — loads icons.json (name + tags), scores each icon by
 *    how many query words appear in its name/tags. Fast, zero deps.
 * 2. (Optional future) vector search using the pre-built icons-vectorstore.json
 *    when @xenova/transformers is available to embed the query.
 *
 * Icons live at `{engineRoot}/static/icons/{weight}/{name}[-{weight}].svg`.
 * When the assets directory is absent, the service fails closed (returns [])
 * matching the Python engine's own designed graceful-degradation path.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { ALLOWED_ICON_WEIGHTS, DEFAULT_ICON_WEIGHT, normalizeIconWeight } from "../utils/icon-weights.js";
import { presentingEngineRoot } from "../paths.js";

function engineRoot(): string {
  const override = (process.env.PRESENTING_ICONS_DIR ?? "").trim();
  if (override) return override;
  return presentingEngineRoot();
}

interface IconEntry {
  name: string;
  tags?: string;
}

interface IconsJson {
  icons: IconEntry[];
}

function iconFilenameForWeight(baseName: string, weight: string): string {
  if (weight === "regular") return `${baseName}.svg`;
  return `${baseName}-${weight}.svg`;
}

function baseIconName(iconName: string): string {
  const name = iconName.split("||")[0];
  for (const weight of ALLOWED_ICON_WEIGHTS) {
    const suffix = `-${weight}`;
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

class IconFinderService {
  private icons: Array<{ base: string; terms: string[] }> | null = null;
  private initialized = false;
  private failed = false;

  private initialize(): void {
    if (this.initialized || this.failed) return;
    this.initialized = true;

    const root = engineRoot();
    const iconsPath = join(root, "assets", "icons.json");
    if (!existsSync(iconsPath)) {
      this.failed = true;
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(iconsPath, "utf8")) as IconsJson;
      this.icons = raw.icons
        .filter((icon) => icon.name.split("-").pop() === "bold")
        .map((icon) => {
          const base = baseIconName(icon.name);
          const terms = [
            ...base.split("-"),
            ...(icon.tags ?? "")
              .split(",")
              .map((t) => t.trim().replace(/^\*|\*$/g, ""))
              .filter(Boolean),
          ].map((t) => t.toLowerCase());
          return { base, terms };
        });
    } catch {
      this.failed = true;
    }
  }

  private ensureInitialized(): boolean {
    if (!this.initialized) this.initialize();
    return !this.failed && this.icons !== null && this.icons.length > 0;
  }

  private iconUrlForWeight(baseName: string, weight: string): string {
    const normalizedWeight = normalizeIconWeight(weight);
    const root = engineRoot();
    const filename = iconFilenameForWeight(baseName, normalizedWeight);
    const candidate = join(root, "static", "icons", normalizedWeight, filename);
    if (!existsSync(candidate)) {
      const fallback = iconFilenameForWeight(baseName, DEFAULT_ICON_WEIGHT);
      return join(root, "static", "icons", DEFAULT_ICON_WEIGHT, fallback);
    }
    return candidate;
  }

  searchIcons(query: string, k = 1, weight?: string): string[] {
    if (!this.ensureInitialized() || !this.icons) return [];

    try {
      const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = this.icons.map((icon) => {
        let score = 0;
        for (const qt of queryTerms) {
          for (const term of icon.terms) {
            if (term === qt) { score += 2; break; }
            if (term.includes(qt) || qt.includes(term)) { score += 1; break; }
          }
        }
        return { base: icon.base, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const iconWeight = normalizeIconWeight(weight);
      return scored
        .slice(0, k)
        .filter((s) => s.score > 0)
        .map((s) => this.iconUrlForWeight(s.base, iconWeight));
    } catch {
      return [];
    }
  }
}

export const ICON_FINDER_SERVICE = new IconFinderService();
