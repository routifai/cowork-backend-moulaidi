/**
 * Tool input type definitions and lightweight runtime validation.
 * Port of presenting/engine/services/chat/schemas.py.
 *
 * Rather than Pydantic, we use plain TypeScript interfaces plus a thin
 * parseArgs() helper that normalises and validates tool inputs at runtime,
 * matching the original field_validator/model_validator behaviour.
 */

import { loadsJsonish as parseJsonish } from "../utils/jsonish.js";
import { MAX_OUTLINE_CONTENT_WORDS } from "../utils/outline-limits.js";

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function nullifyMissing<T extends object>(schema: Record<string, boolean>, raw: T): T {
  const out = { ...raw } as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (!(key in out)) out[key] = null;
  }
  return out as T;
}

function parseContentString(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length < 2) throw new ValidationError("'content' must be a non-empty string");
  const parsed = parseJsonish(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("'content' must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ── Simple inputs ─────────────────────────────────────────────────────────────

export interface AddOutlineInput {
  content: string;
  index: number | null;
}

export interface UpdateOutlineInput {
  index: number;
  content: string;
}

export interface DeleteOutlineInput {
  index: number;
}

export interface MoveOutlineInput {
  fromIndex: number;
  toIndex: number;
}

export interface GetSlideAtIndexInput {
  index: number;
  includeFullContent: boolean;
}

export interface GetSmartPresentationContextInput {
  includeSlideHtml?: boolean;
  maxHtmlCharsPerSlide?: number;
}

export interface SearchSlidesInput {
  query: string;
  limit: number;
}

export interface ReadSourceDocumentsInput {
  query: string | null;
  maxChars: number | null;
}

export interface GetContentSchemaFromLayoutIdInput {
  layoutId: string;
}

export interface GetAvailableBlocksInput {
  query: string | null;
  layoutId: string | null;
  elementType: string | null;
  blockId: string | null;
  includeFullContent: boolean | null;
  maxResults: number | null;
}

export interface GenerateImageInput {
  prompt: string;
}

export interface GenerateIconInput {
  query: string;
}

export interface GenerateAssetItemInput {
  kind: "image" | "icon";
  prompt: string;
}

export interface GenerateAssetsInput {
  assets: GenerateAssetItemInput[];
}

export interface AddNewSlideInput {
  index: number | null;
}

export interface SaveSlideInput {
  content: string;
  layoutId: string;
  index: number;
  replaceOldSlideAtIndex: boolean;
  /** parsed content object */
  _parsedContent?: Record<string, unknown>;
}

export interface SaveSmartSlideInput {
  html: string;
  index: number;
  replaceOldSlideAtIndex: boolean;
  speakerNote?: string | null;
  editPrompt?: string | null;
}

export interface AddNewSlideLayoutInput {
  content: string;
  layoutId: string;
  index: number;
  _parsedContent?: Record<string, unknown>;
}

export interface UpdateSlideInput extends AddNewSlideLayoutInput {}

export interface DeleteSlideInput {
  index: number;
}

export interface GetSlideElementsInput {
  index: number;
  includeFullJson?: boolean | null;
}

// Table/chart/vector/infographic element types

export interface SlideElementPositionInput {
  x: number;
  y: number;
}

export interface SlideElementSizeInput {
  width: number;
  height: number;
}

export interface SlideElementTableCellInput {
  section: "columns" | "rows";
  columnIndex: number;
  rowIndex: number | null;
  text: string;
}

export interface SlideElementChartSeriesInput {
  name: string;
  values: number[];
}

export type DataLabelPosition = "base" | "mid" | "top" | "outside";

export interface SlideElementChartInput {
  chartType?: string | null;
  title?: string | null;
  titleColor?: string | null;
  legendColor?: string | null;
  categories?: string[] | null;
  series?: SlideElementChartSeriesInput[] | null;
  colors?: string[] | null;
  axisColor?: string | null;
  gridColor?: string | null;
  xAxis?: boolean | null;
  yAxis?: boolean | null;
  xAxisGrid?: boolean | null;
  yAxisGrid?: boolean | null;
  xAxisTitle?: string | null;
  yAxisTitle?: string | null;
  dataLabels?: DataLabelPosition | null;
  legend?: boolean | null;
}

export interface SlideElementInfographicDataInput {
  type?: "progress_bar" | "gauge" | null;
  minValue?: number | null;
  maxValue?: number | null;
  value?: number | null;
}

export interface SlideElementInfographicInput {
  data?: SlideElementInfographicDataInput | null;
  colors?: string[] | null;
}

export interface SlideElementTableInput {
  columns?: unknown[] | null;
  headers?: unknown[] | null;
  rows: unknown[][];
}

export interface SlideElementVectorCurveInput {
  type: "smooth";
  tension?: number | null;
  segments?: number | null;
}

export interface SlideElementVectorInput {
  shape?: "polygon" | "ellipse" | null;
  points?: SlideElementPositionInput[] | null;
  closed?: boolean | null;
  curve?: SlideElementVectorCurveInput | null;
  cornerRadii?: number[] | null;
}

export interface SlideElementFontInput {
  family?: string | null;
  size?: number | null;
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  lineHeight?: number | null;
  letterSpacing?: number | null;
  wrap?: "word" | "char" | "none" | null;
  opacity?: number | null;
}

export interface SlideElementAlignmentInput {
  horizontal?: "left" | "center" | "right" | null;
  vertical?: "top" | "middle" | "bottom" | null;
}

export interface SlideElementFillInput {
  color?: string | null;
  opacity?: number | null;
}

export interface SlideElementStrokeInput {
  color?: string | null;
  opacity?: number | null;
  width?: number | null;
  dash?: number[] | null;
}

export interface UpdateSlideElementInput {
  index: number;
  elementPath: string;
  text?: string | null;
  items?: string[] | null;
  tableCell?: SlideElementTableCellInput | null;
  chart?: SlideElementChartInput | null;
  vector?: SlideElementVectorInput | null;
  infographic?: SlideElementInfographicInput | null;
  table?: SlideElementTableInput | null;
  element?: string | null;
  font?: SlideElementFontInput | null;
  alignment?: SlideElementAlignmentInput | null;
  fill?: SlideElementFillInput | null;
  stroke?: SlideElementStrokeInput | null;
  color?: string | null;
  opacity?: number | null;
  position?: SlideElementPositionInput | null;
  size?: SlideElementSizeInput | null;
}

export interface UpdateSlideComponentInput {
  index: number;
  componentId: string;
  position?: SlideElementPositionInput | null;
  size?: SlideElementSizeInput | null;
}

export interface DeleteSlideComponentInput {
  index: number;
  componentId: string;
}

export interface DeleteSlideElementInput {
  index: number;
  elementPath: string;
}

export interface AddElementInput {
  index: number;
  element: string;
  componentId?: string | null;
  insertIndex?: number | null;
}

export interface AddSlideComponentInput {
  index: number;
  component: string;
  sourceBlockId?: string | null;
  insertIndex?: number | null;
}

export interface UpdateComponentInput {
  index: number;
  componentId: string;
  action?: string | null;
  componentIds?: string[] | null;
  position?: SlideElementPositionInput | null;
  size?: SlideElementSizeInput | null;
  component?: string | null;
}

export interface ThemeTextFontInput {
  name?: string | null;
  url?: string | null;
}

export interface ThemeFontsInput {
  textFont?: ThemeTextFontInput | null;
}

export interface ThemeColorsInput {
  primary?: string | null;
  background?: string | null;
  card?: string | null;
  stroke?: string | null;
  primary_text?: string | null;
  background_text?: string | null;
  graph_0?: string | null;
  graph_1?: string | null;
  graph_2?: string | null;
  graph_3?: string | null;
  graph_4?: string | null;
  graph_5?: string | null;
  graph_6?: string | null;
  graph_7?: string | null;
  graph_8?: string | null;
  graph_9?: string | null;
}

export interface CustomThemeDataInput {
  name?: string | null;
  description?: string | null;
  colors?: ThemeColorsInput | null;
  fonts?: ThemeFontsInput | null;
  textFont?: ThemeTextFontInput | null;
}

export interface CustomThemeInput {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  user?: string | null;
  logo?: string | null;
  logoUrl?: string | null;
  companyName?: string | null;
  data?: CustomThemeDataInput | null;
  colors?: ThemeColorsInput | null;
  fonts?: ThemeFontsInput | null;
  textFont?: ThemeTextFontInput | null;
}

export interface SetPresentationThemeInput {
  theme?: string | null;
  customTheme?: CustomThemeInput | null;
  saveCustomTheme?: boolean | null;
}

// ── Runtime normalisation helpers ─────────────────────────────────────────────

/** Normalise incoming chart fields that the LLM may have put at the root level. */
export function normalizeUpdateElementArgs(raw: Record<string, unknown>): UpdateSlideElementInput {
  const n = { ...raw } as Record<string, unknown>;

  // Promote top-level chart keys into a nested chart object
  const CHART_KEYS = [
    "chartType", "chart_type", "categories", "series", "colors",
    "dataLabels", "data_labels", "axisColor", "axis_color",
    "gridColor", "grid_color", "legend", "title", "titleColor", "title_color",
    "legendColor", "legend_color", "xAxis", "x_axis", "yAxis", "y_axis",
    "xAxisGrid", "x_axis_grid", "yAxisGrid", "y_axis_grid",
    "xAxisTitle", "x_axis_title", "yAxisTitle", "y_axis_title",
  ];
  if (!("chart" in n) && CHART_KEYS.some((k) => k in n)) {
    const chart: Record<string, unknown> = {};
    for (const k of CHART_KEYS) {
      if (k in n) { chart[k] = n[k]; delete n[k]; }
    }
    n.chart = chart;
  }

  // Normalise font aliases
  const FONT_ALIASES: Record<string, string> = {
    fontFamily: "family", font_family: "family", fontName: "family", font_name: "family", name: "family",
    fontSize: "size", font_size: "size",
    fontColor: "color", font_color: "color", textColor: "color", text_color: "color",
    bold: "bold", italic: "italic", underline: "underline",
    lineHeight: "lineHeight", line_height: "lineHeight",
    letterSpacing: "letterSpacing", letter_spacing: "letterSpacing",
    wrap: "wrap",
  };
  const fontPatch: Record<string, unknown> = typeof n.font === "object" && n.font ? { ...(n.font as object) } : {};
  for (const [src, tgt] of Object.entries(FONT_ALIASES)) {
    if (src in n && !(tgt in fontPatch)) { fontPatch[tgt] = n[src]; delete n[src]; }
  }
  if (Object.keys(fontPatch).length) n.font = fontPatch;

  // Normalise alignment aliases
  const ALIGN_ALIASES: Record<string, string> = {
    align: "horizontal", textAlign: "horizontal", text_align: "horizontal",
    horizontalAlign: "horizontal", horizontal_align: "horizontal", horizontalAlignment: "horizontal",
    verticalAlign: "vertical", vertical_align: "vertical", verticalAlignment: "vertical",
  };
  const alignPatch: Record<string, unknown> = typeof n.alignment === "object" && n.alignment ? { ...(n.alignment as object) } : {};
  for (const [src, tgt] of Object.entries(ALIGN_ALIASES)) {
    if (src in n && !(tgt in alignPatch)) { alignPatch[tgt] = n[src]; delete n[src]; }
  }
  if (Object.keys(alignPatch).length) n.alignment = alignPatch;

  // Normalise fill/stroke aliases
  const fillPatch: Record<string, unknown> = typeof n.fill === "object" && n.fill ? { ...(n.fill as object) } : {};
  for (const src of ["fillColor", "fill_color", "backgroundColor", "background_color"]) {
    if (src in n && !("color" in fillPatch)) { fillPatch.color = n[src]; delete n[src]; }
  }
  for (const src of ["fillOpacity", "fill_opacity"]) {
    if (src in n && !("opacity" in fillPatch)) { fillPatch.opacity = n[src]; delete n[src]; }
  }
  if (Object.keys(fillPatch).length) n.fill = fillPatch;

  const strokePatch: Record<string, unknown> = typeof n.stroke === "object" && n.stroke ? { ...(n.stroke as object) } : {};
  for (const src of ["strokeColor", "stroke_color", "borderColor", "border_color"]) {
    if (src in n && !("color" in strokePatch)) { strokePatch.color = n[src]; delete n[src]; }
  }
  for (const src of ["strokeWidth", "stroke_width", "borderWidth", "border_width"]) {
    if (src in n && !("width" in strokePatch)) { strokePatch.width = n[src]; delete n[src]; }
  }
  for (const src of ["strokeOpacity", "stroke_opacity"]) {
    if (src in n && !("opacity" in strokePatch)) { strokePatch.opacity = n[src]; delete n[src]; }
  }
  if (Object.keys(strokePatch).length) n.stroke = strokePatch;

  // Normalise alias: element_path → elementPath
  if ("element_path" in n && !("elementPath" in n)) { n.elementPath = n.element_path; delete n.element_path; }

  return n as unknown as UpdateSlideElementInput;
}

export function normalizeComponentId(raw: Record<string, unknown>): Record<string, unknown> {
  const n = { ...raw };
  if ("component_id" in n && !("componentId" in n)) { n.componentId = n.component_id; delete n.component_id; }
  return n;
}

/** Parse content JSON string for save/update tools. Returns the raw string AND parsed object. */
export function parseSlideContent(raw: Record<string, unknown>): {
  contentStr: string;
  contentObj: Record<string, unknown>;
} {
  const contentStr = String(raw.content ?? "");
  const contentObj = parseContentString(contentStr);
  return { contentStr, contentObj };
}
