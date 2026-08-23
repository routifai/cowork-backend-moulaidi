/**
 * Slide UI element/component manipulation helpers.
 * Port of presenting/engine/services/chat/slide_ui_helpers.py — key functions
 * for path resolution, element content updates, and style patching.
 */

import { replaceTextRuns } from "../utils/latex-text.js";

const PATH_SEGMENT_RE = /^(?<key>components|elements|children)\[(?<index>\d+)\]$/;

export const CONTENT_EDITABLE_ELEMENT_TYPES = new Set([
  "text", "math", "text-list", "table", "image", "chart", "vector", "infographic",
]);

export const VISIBLE_ELEMENT_TYPES = new Set([
  ...CONTENT_EDITABLE_ELEMENT_TYPES,
  "container", "svg", "flex", "grid", "grid-view", "group",
]);

export const DEFAULT_CHART_COLORS = [
  "#7F22FE", "#155DFC", "#F59E0B", "#12B76A",
  "#EF4444", "#06B6D4", "#8B5CF6", "#64748B",
];

export const SUPPORTED_CHART_TYPES = new Set([
  "area", "bar", "bubble", "donut", "horizontal_bar", "horizontal_stacked_bar",
  "line", "pie", "polar_area", "radar", "scatter", "stacked_bar",
]);

// ── Path resolution ───────────────────────────────────────────────────────────

export function resolveElementPath(layoutDict: Record<string, unknown>, path: string): Record<string, unknown> {
  let current: unknown = layoutDict;
  for (const segment of path.split(".")) {
    if (segment === "child") {
      if (!current || typeof current !== "object" || !("child" in (current as object))) {
        throw new Error(`Invalid element path segment: ${segment}`);
      }
      current = (current as Record<string, unknown>).child;
      continue;
    }
    const match = PATH_SEGMENT_RE.exec(segment);
    if (!match?.groups) throw new Error(`Invalid element path segment: ${segment}`);
    const key = match.groups.key;
    const index = parseInt(match.groups.index, 10);
    if (!current || typeof current !== "object") throw new Error(`Invalid element path segment: ${segment}`);
    const arr = (current as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) throw new Error(`Invalid element path segment: ${segment}`);
    if (index >= arr.length || typeof arr[index] !== "object") throw new Error(`Invalid element path index: ${segment}`);
    current = arr[index];
  }
  if (!current || typeof current !== "object" || typeof (current as any).type !== "string") {
    throw new Error("Path does not resolve to an element.");
  }
  return current as Record<string, unknown>;
}

export function componentIdForPath(layoutDict: Record<string, unknown>, path: string): string | null {
  const first = path.split(".", 1)[0];
  const match = PATH_SEGMENT_RE.exec(first);
  if (!match?.groups || match.groups.key !== "components") return null;
  const index = parseInt(match.groups.index, 10);
  const components = layoutDict.components;
  if (!Array.isArray(components) || index >= components.length) return null;
  const comp = components[index];
  return typeof comp === "object" && comp ? String((comp as any).id ?? "") : null;
}

// ── Editable element collection ───────────────────────────────────────────────

function elementContent(element: Record<string, unknown>): unknown {
  const type = element.type as string;
  if (type === "text") {
    return { text: runsText(element.runs as unknown[]) };
  }
  if (type === "math") {
    return { latex: element.latex, display_mode: element.display_mode ?? true };
  }
  if (type === "text-list") {
    const items = Array.isArray(element.items) ? element.items : [];
    return { items: items.map(runsText) };
  }
  if (type === "table") {
    const columns = Array.isArray(element.columns) ? element.columns
      : Array.isArray(element.headers) ? element.headers : [];
    return {
      columns: columns.map(tableValueText),
      rows: (Array.isArray(element.rows) ? element.rows : [])
        .filter(Array.isArray)
        .map((row) => (row as unknown[]).map(tableValueText)),
    };
  }
  if (type === "chart") {
    return {
      chart_type: element.chart_type,
      title: element.title,
      categories: element.categories,
      series: element.series,
    };
  }
  if (type === "image") {
    return { data: element.data, is_icon: element.is_icon };
  }
  if (type === "vector") {
    return { shape: element.shape, points: element.points, closed: element.closed };
  }
  if (type === "infographic") {
    return { data: element.data, colors: element.colors };
  }
  return null;
}

function elementLimits(element: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "max_length", "min_length", "max_items", "min_items",
    "max_item_length", "min_item_length", "max_columns", "min_columns",
    "max_rows", "min_rows", "max_children", "min_children", "max_value", "min_value",
  ];
  const result: Record<string, unknown> = {};
  for (const k of keys) { if (k in element) result[k] = element[k]; }
  return result;
}

function elementStyle(element: Record<string, unknown>): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const k of ["font", "fill", "stroke", "opacity", "color", "position", "size", "rotation"]) {
    if (k in element) style[k] = element[k];
  }
  return style;
}

function visitEditableElement(
  element: Record<string, unknown>,
  path: string,
  componentId: string,
  editable: unknown[],
  includeVisual: boolean,
): void {
  const type = String(element.type ?? "");
  const isContentEditable = CONTENT_EDITABLE_ELEMENT_TYPES.has(type);
  if (isContentEditable || (includeVisual && VISIBLE_ELEMENT_TYPES.has(type))) {
    editable.push({
      path,
      component_id: componentId,
      type,
      name: element.name,
      decorative: element.decorative,
      content_editable: isContentEditable,
      geometry_editable: true,
      content: elementContent(element),
      style: elementStyle(element),
      limits: elementLimits(element),
    });
  }
  if (element.child && typeof element.child === "object") {
    visitEditableElement(element.child as Record<string, unknown>, `${path}.child`, componentId, editable, includeVisual);
  }
  if (Array.isArray(element.children)) {
    (element.children as unknown[]).forEach((child, i) => {
      if (child && typeof child === "object") {
        visitEditableElement(child as Record<string, unknown>, `${path}.children[${i}]`, componentId, editable, includeVisual);
      }
    });
  }
}

export function collectEditableElements(layoutDict: Record<string, unknown>, includeVisualElements = false): unknown[] {
  const editable: unknown[] = [];
  if (Array.isArray(layoutDict.elements)) {
    (layoutDict.elements as unknown[]).forEach((el, i) => {
      if (el && typeof el === "object") {
        visitEditableElement(el as Record<string, unknown>, `elements[${i}]`, "", editable, includeVisualElements);
      }
    });
  }
  if (Array.isArray(layoutDict.components)) {
    (layoutDict.components as unknown[]).forEach((comp, ci) => {
      if (!comp || typeof comp !== "object") return;
      const c = comp as Record<string, unknown>;
      const cid = String(c.id ?? "");
      if (Array.isArray(c.elements)) {
        (c.elements as unknown[]).forEach((el, ei) => {
          if (el && typeof el === "object") {
            visitEditableElement(el as Record<string, unknown>, `components[${ci}].elements[${ei}]`, cid, editable, includeVisualElements);
          }
        });
      }
    });
  }
  return editable;
}

export function compactComponents(layoutDict: Record<string, unknown>): unknown[] {
  if (!Array.isArray(layoutDict.components)) return [];
  return (layoutDict.components as unknown[]).map((comp) => {
    if (!comp || typeof comp !== "object") return null;
    const c = comp as Record<string, unknown>;
    return {
      component_id: c.id,
      description: c.description,
      element_count: Array.isArray(c.elements) ? c.elements.length : 0,
      element_types: Array.isArray(c.elements)
        ? (c.elements as unknown[]).map((e) => (e && typeof e === "object" ? (e as any).type : null))
        : [],
    };
  }).filter(Boolean);
}

// ── Element content updates ───────────────────────────────────────────────────

function runsText(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter((r) => r.type === "text" || !r.type)
    .map((r) => String(r.text ?? r.content ?? ""))
    .join("");
}

function tableValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.runs)) { const t = runsText(v.runs); if (t) return t; }
    for (const k of ["text", "content", "value", "label", "data"]) {
      if (k in v) return tableValueText(v[k]);
    }
    return "";
  }
  if (Array.isArray(value)) return (value as unknown[]).map(tableValueText).join("");
  return String(value);
}

function replacementRuns(existingRuns: unknown, text: string, fallbackFont?: unknown): unknown[] {
  return replaceTextRuns(existingRuns, text, fallbackFont) as unknown[];
}

export function updateTextElement(element: Record<string, unknown>, text: string): void {
  element.runs = replacementRuns(element.runs, text, element.font);
  if ((element.runs as unknown[]).some((r: any) => r.type === "latex")) {
    delete element.text;
  } else {
    element.text = text;
  }
}

export function updateTextListElement(element: Record<string, unknown>, items: string[]): void {
  const minItems = element.min_items as number | undefined;
  const maxItems = element.max_items as number | undefined;
  if (minItems !== undefined && items.length < minItems) throw new Error(`Text list requires at least ${minItems} item(s).`);
  if (maxItems !== undefined && items.length > maxItems) throw new Error(`Text list allows at most ${maxItems} item(s).`);
  const sourceItems = Array.isArray(element.items) ? element.items as unknown[] : [];
  element.items = items.map((item, i) => replacementRuns(sourceItems[i] ?? null, item, element.font));
}

export function updateTableCellInElement(element: Record<string, unknown>, tableCell: Record<string, unknown>): void {
  const section = String(tableCell.section);
  const columnIndex = Number(tableCell.column_index ?? tableCell.columnIndex);
  const text = String(tableCell.text ?? "");
  if (section === "columns") {
    if (!Array.isArray(element.columns) || columnIndex >= (element.columns as unknown[]).length) throw new Error("Invalid table column index.");
    const cell = (element.columns as unknown[])[columnIndex] as Record<string, unknown>;
    cell.runs = replacementRuns(cell.runs, text, cell.font);
  } else {
    const rowIndex = Number(tableCell.row_index ?? tableCell.rowIndex);
    if (!Array.isArray(element.rows) || rowIndex >= (element.rows as unknown[]).length) throw new Error("Invalid table row index.");
    const row = (element.rows as unknown[])[rowIndex] as unknown[];
    if (!Array.isArray(row) || columnIndex >= row.length) throw new Error("Invalid table cell index.");
    const cell = row[columnIndex] as Record<string, unknown>;
    if (cell && typeof cell === "object") {
      cell.runs = replacementRuns(cell.runs, text, cell.font);
    } else {
      row[columnIndex] = { runs: replacementRuns(null, text, null) };
    }
  }
}

function replacementTableCell(value: unknown, existing: Record<string, unknown> | null): Record<string, unknown> {
  const cell: Record<string, unknown> = existing ? { ...existing } : {};
  cell.runs = replacementRuns(cell.runs, tableValueText(value), cell.font);
  return cell;
}

export function updateTableElement(element: Record<string, unknown>, table: Record<string, unknown>): void {
  const columns = table.columns ?? table.headers;
  const rows = table.rows;
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error("table update requires columns/headers and rows.");
  if (!(rows as unknown[]).every(Array.isArray)) throw new Error("table rows must be lists.");
  const colCount = columns.length;
  if (colCount === 0) throw new Error("table must contain at least one column.");
  if ((rows as unknown[][]).some((r) => r.length !== colCount)) throw new Error("each table row must match the column count.");

  const existingColumns = Array.isArray(element.columns) ? element.columns as unknown[] : [];
  const existingRows = (Array.isArray(element.rows) ? element.rows as unknown[] : [])
    .map((row) => Array.isArray(row) ? row as unknown[] : []);

  element.columns = columns.map((v, i) => replacementTableCell(v, existingColumns[i] as Record<string, unknown> ?? null));
  element.rows = (rows as unknown[][]).map((row, ri) =>
    row.map((v, ci) => replacementTableCell(v, (existingRows[ri]?.[ci] as Record<string, unknown>) ?? null))
  );
}

export function updateVectorElement(element: Record<string, unknown>, vector: Record<string, unknown>): void {
  for (const key of ["shape", "points", "closed", "curve", "corner_radii", "cornerRadii"]) {
    if (key in vector) element[key === "cornerRadii" ? "corner_radii" : key] = JSON.parse(JSON.stringify(vector[key]));
  }
}

export function updateInfographicElement(element: Record<string, unknown>, infographic: Record<string, unknown>): void {
  if ("data" in infographic) {
    const current = element.data as Record<string, unknown> ?? {};
    element.data = { ...current, ...JSON.parse(JSON.stringify(infographic.data)) };
  }
  if ("colors" in infographic) element.colors = JSON.parse(JSON.stringify(infographic.colors));
}

function normalizeChartType(value: unknown): string {
  const s = String(value ?? "bar").toLowerCase().replace(/-/g, "_");
  return SUPPORTED_CHART_TYPES.has(s) ? s : "bar";
}

function normalizeChartSeries(series: unknown, fallbackName = "Series 1"): Array<{ name: string; values: number[] }> {
  if (!Array.isArray(series) || series.length === 0) return [];
  return series
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      name: String(s.name ?? s.label ?? fallbackName),
      values: (Array.isArray(s.values) ? s.values : Array.isArray(s.data) ? s.data : [])
        .map(Number)
        .filter((n) => isFinite(n)),
    }))
    .filter((s) => s.values.length > 0);
}

function themeChartPalette(theme: unknown): string[] {
  if (!theme || typeof theme !== "object") return DEFAULT_CHART_COLORS;
  const colors = (theme as any).data?.colors ?? (theme as any).colors;
  if (!colors) return DEFAULT_CHART_COLORS;
  const palette: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = colors[`graph_${i}`];
    if (c) palette.push(String(c));
  }
  return palette.length >= 2 ? palette : DEFAULT_CHART_COLORS;
}

export function normalizeChartElement(element: Record<string, unknown>, theme?: unknown): void {
  // Remove deprecated fields
  delete element.data_labels_color;
  delete element.dataLabelsColor;
  delete element.grid;
  if ("titleColor" in element && !("title_color" in element)) element.title_color = element.titleColor;
  if ("legendColor" in element && !("legend_color" in element)) element.legend_color = element.legendColor;

  element.chart_type = normalizeChartType(element.chart_type ?? element.chartType);
  delete element.chartType;

  const series = normalizeChartSeries(element.series, String(element.title ?? "Series 1"));
  if (!series.length) element.series = [{ name: "Series 1", values: [0] }];
  else element.series = series;

  // Ensure categories array is set and matches series length
  if (!Array.isArray(element.categories) || element.categories.length === 0) {
    const maxLen = Math.max(1, ...(element.series as any[]).map((s: any) => s.values.length));
    element.categories = Array.from({ length: maxLen }, (_, i) => `Category ${i + 1}`);
  }

  // Resolve colors from theme if not provided
  if (!Array.isArray(element.colors) || element.colors.length === 0) {
    element.colors = themeChartPalette(theme);
  }
}

export function updateChartElement(element: Record<string, unknown>, chart: Record<string, unknown>, theme?: unknown): void {
  // Merge chart update fields (camelCase → snake_case normalisation)
  const CAMEL_MAP: Record<string, string> = {
    chartType: "chart_type", titleColor: "title_color", legendColor: "legend_color",
    axisColor: "axis_color", gridColor: "grid_color", xAxis: "x_axis", yAxis: "y_axis",
    xAxisGrid: "x_axis_grid", yAxisGrid: "y_axis_grid", xAxisTitle: "x_axis_title",
    yAxisTitle: "y_axis_title", dataLabels: "data_labels",
  };
  const merged: Record<string, unknown> = { ...element };
  for (const [src, tgt] of Object.entries(CAMEL_MAP)) {
    if (src in chart) { merged[tgt] = chart[src]; delete merged[src]; }
  }
  for (const k of ["title", "categories", "series", "colors", "legend"]) {
    if (k in chart) merged[k] = chart[k];
  }
  Object.assign(element, merged);
  normalizeChartElement(element, theme);
}

// ── Style patching ────────────────────────────────────────────────────────────

function normalizeFontPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const aliases: Record<string, string> = {
    family: "family", fontFamily: "family", font_family: "family", fontName: "family", name: "family",
    size: "size", fontSize: "size", font_size: "size",
    color: "color", fontColor: "color", font_color: "color", textColor: "color", text_color: "color",
    bold: "bold", italic: "italic", underline: "underline",
    line_height: "line_height", lineHeight: "line_height",
    letter_spacing: "letter_spacing", letterSpacing: "letter_spacing",
    wrap: "wrap", opacity: "opacity",
  };
  const out: Record<string, unknown> = {};
  for (const [src, tgt] of Object.entries(aliases)) {
    if (src in raw) out[tgt] = raw[src];
  }
  return out;
}

function mergeFontPatch(element: Record<string, unknown>, fontPatch: Record<string, unknown>): void {
  const existing = element.font as Record<string, unknown> ?? {};
  element.font = { ...existing, ...fontPatch };
}

function applyFontPatchToRuns(runs: unknown, fontPatch: Record<string, unknown>): void {
  if (!Array.isArray(runs)) return;
  for (const run of runs) {
    if (run && typeof run === "object" && (run as any).type === "text") {
      const r = run as Record<string, unknown>;
      r.font = { ...(r.font as object ?? {}), ...fontPatch };
    }
  }
}

export function applyElementStylePatch(element: Record<string, unknown>, patch: Record<string, unknown>): void {
  const type = String(element.type ?? "");
  if ("color" in patch && typeof patch.color === "string") {
    const TEXT_STYLE_TYPES = new Set(["text", "math", "text-list", "table"]);
    if (TEXT_STYLE_TYPES.has(type)) {
      element.font = { ...(element.font as object ?? {}), color: patch.color };
    } else if (type === "vector") {
      const pts = Array.isArray(element.points) ? element.points : [];
      const isClosed = element.shape === "ellipse" || (typeof element.closed === "boolean" ? element.closed : pts.length > 2);
      const styleKey = isClosed ? "fill" : "stroke";
      element[styleKey] = { ...(element[styleKey] as object ?? {}), color: patch.color };
    } else if (type === "infographic") {
      const colors = Array.isArray(element.colors) ? element.colors as unknown[] : [];
      element.colors = [colors[0] ?? "#E5E7EB", patch.color, ...colors.slice(2)];
    }
  }

  if ("font" in patch && patch.font && typeof patch.font === "object") {
    const fontPatch = normalizeFontPatch(patch.font as Record<string, unknown>);
    const TEXT_STYLE_TYPES = new Set(["text", "math", "text-list", "table"]);
    if (TEXT_STYLE_TYPES.has(type)) {
      mergeFontPatch(element, fontPatch);
      if (type === "text" && Array.isArray(element.runs)) applyFontPatchToRuns(element.runs, fontPatch);
      if (type === "text-list" && Array.isArray(element.items)) {
        for (const item of element.items as unknown[]) {
          if (Array.isArray(item)) applyFontPatchToRuns(item, fontPatch);
        }
      }
    }
  }

  if ("fill" in patch && patch.fill && typeof patch.fill === "object") {
    element.fill = { ...(element.fill as object ?? {}), ...(patch.fill as object) };
  }
  if ("stroke" in patch && patch.stroke && typeof patch.stroke === "object") {
    element.stroke = { ...(element.stroke as object ?? {}), ...(patch.stroke as object) };
  }
  if ("alignment" in patch && patch.alignment && typeof patch.alignment === "object") {
    element.alignment = { ...(element.alignment as object ?? {}), ...(patch.alignment as object) };
  }
  if ("opacity" in patch) element.opacity = patch.opacity;
}

// ── Asset helpers ─────────────────────────────────────────────────────────────

export function looksLikeAssetReference(value: string): boolean {
  const s = value.trim();
  return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("/app_data/") ||
    s.startsWith("/static/") || s.startsWith("data:") || s.startsWith("blob:");
}

export function resolveImageUpdatePayload(text: string | null, items: string[] | null): string | Record<string, unknown> | null {
  if (text !== null) {
    const s = text.trim();
    if (!s) return null;
    if (s.startsWith("{") && s.endsWith("}")) {
      try { const p = JSON.parse(s); if (p && typeof p === "object") return p; } catch { }
    }
    return text;
  }
  if (Array.isArray(items) && items.length === 1) {
    const c = String(items[0] ?? "").trim();
    if (c) return c;
  }
  return null;
}

export function applyImageElementValue(element: Record<string, unknown>, payload: string | Record<string, unknown>): void {
  if (typeof payload === "object") {
    Object.assign(element, payload);
  } else {
    element.data = payload;
  }
}

export function contentUpdateRequestedForType(
  elementType: string,
  args: {
    text?: string | null;
    items?: string[] | null;
    tableCell?: Record<string, unknown> | null;
    table?: Record<string, unknown> | null;
    chart?: Record<string, unknown> | null;
    vector?: Record<string, unknown> | null;
    infographic?: Record<string, unknown> | null;
  },
): boolean {
  const { text, items, tableCell, table, chart, vector, infographic } = args;
  if (elementType === "text" || elementType === "math") return text !== null && text !== undefined;
  if (elementType === "text-list") return items !== null && items !== undefined;
  if (elementType === "table") return table !== null || tableCell !== null;
  if (elementType === "chart") return !!chart && Object.keys(chart).some((k) => chart[k] !== null && chart[k] !== undefined);
  if (elementType === "vector") return !!vector && Object.keys(vector).length > 0;
  if (elementType === "infographic") return !!infographic && Object.keys(infographic).length > 0;
  if (elementType === "image") return resolveImageUpdatePayload(text ?? null, items ?? null) !== null;
  return [text, items, tableCell, table, chart, vector, infographic].some((v) => v !== null && v !== undefined);
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

export function updateElementBox(
  element: Record<string, unknown>,
  position?: { x: number; y: number } | null,
  size?: { width: number; height: number } | null,
): boolean {
  let updated = false;
  if (position) { element.position = { ...position }; updated = true; }
  if (size) { element.size = { ...size }; updated = true; }
  return updated;
}

export function mergeUiPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] !== null) {
      mergeUiPatch(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = JSON.parse(JSON.stringify(v));
    }
  }
}

export function validateCurrentElementModel(element: Record<string, unknown>): void {
  const type = element.type as string;
  if (type === "chart") {
    if (!Array.isArray(element.series) || !element.series.length) throw new Error("Chart elements must include numeric data (series).");
    const categories = element.categories as unknown[];
    if (!Array.isArray(categories) || !categories.length) throw new Error("Chart elements must include categories.");
  }
  if (type === "table") {
    if (!Array.isArray(element.columns) && !Array.isArray(element.headers)) throw new Error("Table elements must include columns/headers.");
    if (!Array.isArray(element.rows)) throw new Error("Table elements must include rows.");
  }
  if (type === "image") {
    if (!element.data) throw new Error("Image elements must include a data URL.");
  }
}
