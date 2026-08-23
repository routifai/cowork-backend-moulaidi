/**
 * Outline word-limit helpers.
 * Port of presenting/engine/services/outline_limits.py
 */

export const MAX_OUTLINE_CONTENT_WORDS = 100;
const WORD_RE = /\S+/g;

export function countOutlineWords(text: string): number {
  return (text ?? "").match(WORD_RE)?.length ?? 0;
}

export function trimTextToWordLimit(text: string, maxWords = MAX_OUTLINE_CONTENT_WORDS): string {
  if (maxWords <= 0) return "";
  const matches = [...(text ?? "").matchAll(/\S+/g)];
  if (matches.length <= maxWords) return text;
  const lastMatch = matches[maxWords - 1];
  return text.slice(0, lastMatch.index! + lastMatch[0].length).trimEnd();
}

export function normalizeOutlineContent(value: unknown): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : String(value);
  return trimTextToWordLimit(str, MAX_OUTLINE_CONTENT_WORDS);
}

export function normalizeOutlinePayload(payload: Record<string, unknown>, maxSlides: number): Record<string, unknown> {
  const normalized = { ...payload };
  const rawSlides = normalized.slides;
  if (!Array.isArray(rawSlides)) return normalized;
  normalized.slides = rawSlides.slice(0, maxSlides).map((slide) => {
    if (typeof slide === "object" && slide !== null) {
      return { ...(slide as Record<string, unknown>), content: normalizeOutlineContent((slide as any).content ?? "") };
    }
    return { content: normalizeOutlineContent(slide) };
  });
  return normalized;
}
