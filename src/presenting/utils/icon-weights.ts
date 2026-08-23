/**
 * Icon-weight normalization.
 * Port of presenting/engine/services/icon_weights.py
 */

export const DEFAULT_ICON_WEIGHT = "bold";
export const ALLOWED_ICON_WEIGHTS = ["bold", "duotone", "fill", "light", "regular", "thin"] as const;
export const DEFAULT_ICON_TYPE = DEFAULT_ICON_WEIGHT;
export const ALLOWED_ICON_TYPES = ALLOWED_ICON_WEIGHTS;

export function normalizeIconWeight(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_ICON_WEIGHT;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return (ALLOWED_ICON_WEIGHTS as readonly string[]).includes(normalized) ? normalized : DEFAULT_ICON_WEIGHT;
}

export const normalizeIconType = normalizeIconWeight;

function containsIconSetting(settings: Record<string, unknown>): boolean {
  if ("icon_type" in settings || "icon_weight" in settings) return true;
  const nested = settings.settings;
  return typeof nested === "object" && nested !== null && containsIconSetting(nested as Record<string, unknown>);
}

export function extractIconTypeFromSettings(settings: unknown): string {
  if (!settings || typeof settings !== "object") return DEFAULT_ICON_TYPE;
  const s = settings as Record<string, unknown>;
  const nested = s.settings;
  if (typeof nested === "object" && nested !== null && containsIconSetting(nested as Record<string, unknown>)) {
    return extractIconTypeFromSettings(nested);
  }
  if ("icon_type" in s) return normalizeIconType(s.icon_type);
  if ("icon_weight" in s) return normalizeIconType(s.icon_weight);
  return DEFAULT_ICON_TYPE;
}
