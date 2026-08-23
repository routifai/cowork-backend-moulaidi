/**
 * LaTeX tag parsing for text runs.
 * Port of presenting/engine/services/latex_text.py
 */

export type TextRun = Record<string, unknown>;

export function normalizeLatex(value: string): string {
  const s = value.trim();
  if (s.startsWith("$$") && s.endsWith("$$") && s.length > 4) return s.slice(2, -2).trim().slice(0, 4000);
  if (s.startsWith("\\[") && s.endsWith("\\]") && s.length > 4) return s.slice(2, -2).trim().slice(0, 4000);
  return s.slice(0, 4000);
}

function isLatexRun(run: Record<string, unknown>): boolean {
  return run.type === "latex";
}

export function parseLatexTags(value: string): TextRun[] | null {
  const runs: TextRun[] = [];
  let buf = "";
  let inLatex = false;
  let sawLatex = false;
  let i = 0;

  const flush = () => {
    if (!buf) return;
    if (inLatex) {
      const latex = normalizeLatex(buf);
      if (!latex) return;
      if (runs.length && isLatexRun(runs[runs.length - 1])) {
        (runs[runs.length - 1] as any).latex += latex;
      } else {
        runs.push({ type: "latex", latex });
      }
    } else {
      if (runs.length && !isLatexRun(runs[runs.length - 1])) {
        (runs[runs.length - 1] as any).text += buf;
      } else {
        runs.push({ text: buf });
      }
    }
    buf = "";
  };

  while (i < value.length) {
    // Check for <latex> or </latex>
    const openTag = value.slice(i).match(/^<latex>/i);
    const closeTag = value.slice(i).match(/^<\/latex>/i);

    if (openTag) {
      if (inLatex) return null; // nested <latex>
      flush();
      inLatex = true;
      sawLatex = true;
      i += openTag[0].length;
    } else if (closeTag) {
      if (!inLatex) return null; // unmatched </latex>
      flush();
      inLatex = false;
      i += closeTag[0].length;
    } else {
      buf += value[i];
      i++;
    }
  }

  if (inLatex) return null; // unclosed <latex>
  flush();
  if (!sawLatex) return null;
  return runs;
}

function matchingTemplateRun(templates: TextRun[], parsed: TextRun, index: number): TextRun | null {
  if (index < templates.length && isLatexRun(templates[index]) === isLatexRun(parsed)) return templates[index];
  for (const t of templates) if (isLatexRun(t) === isLatexRun(parsed)) return t;
  if (index < templates.length) return templates[index];
  return templates[0] ?? null;
}

function applyFallbackFont(run: TextRun, fallbackFont: unknown): void {
  if (typeof fallbackFont === "object" && fallbackFont !== null && typeof run.font !== "object") {
    run.font = { ...(fallbackFont as object) };
  }
}

function buildParsedRun(parsed: TextRun, template: TextRun | null, fallbackFont: unknown): TextRun {
  const run: TextRun = template ? { ...template } : {};
  applyFallbackFont(run, fallbackFont);
  if (isLatexRun(parsed)) {
    const wasLatex = isLatexRun(run);
    run.type = "latex";
    run.latex = parsed.latex;
    delete run.text;
    if (!wasLatex) run.display_mode = false;
  } else {
    delete run.type;
    delete run.latex;
    delete run.display_mode;
    run.text = parsed.text;
  }
  return run;
}

function replaceSingleRun(template: TextRun | null, value: string, fallbackFont: unknown): TextRun {
  const run: TextRun = template ? { ...template } : {};
  applyFallbackFont(run, fallbackFont);
  if (isLatexRun(run)) {
    run.latex = normalizeLatex(value);
    delete run.text;
  } else {
    run.text = value;
  }
  return run;
}

export function replaceTextRuns(existingRuns: unknown, value: string, fallbackFont: unknown = null): TextRun[] {
  const parsedRuns = parseLatexTags(value);
  const templates = Array.isArray(existingRuns) ? (existingRuns as TextRun[]).filter((r) => typeof r === "object" && r !== null) : [];
  if (parsedRuns === null) return [replaceSingleRun(templates[0] ?? null, value, fallbackFont)];
  return parsedRuns.map((parsed, index) => buildParsedRun(parsed, matchingTemplateRun(templates, parsed, index), fallbackFont));
}
