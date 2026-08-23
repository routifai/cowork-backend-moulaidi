/**
 * Lenient JSON parsing for LLM completions.
 * Port of presenting/engine/services/jsonish.py
 */

function jsonishCandidates(value: string): string[] {
  const stripped = (value ?? "").trim();
  if (!stripped) return [];

  const candidates: string[] = [stripped];
  
  const fenceMatch = stripped.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  for (const [opener, closer] of [["{", "}"], ["[", "]"]] as [string, string][]) {
    const start = stripped.indexOf(opener);
    const end = stripped.lastIndexOf(closer);
    if (start !== -1 && end > start) candidates.push(stripped.slice(start, end + 1).trim());
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c && !seen.has(c)) { seen.add(c); unique.push(c); }
  }
  return unique;
}

export function loadsJsonish(value: string): unknown {
  let lastError: unknown;
  for (const candidate of jsonishCandidates(value)) {
    try { return JSON.parse(candidate); } catch (e) { lastError = e; }
  }
  if (lastError) throw lastError;
  throw new Error("JSON value is empty.");
}
