/**
 * Template V2 layout <-> content binding.
 *
 * Two directions:
 *   - buildTemplateLayoutModel(): raw template.json data -> PresentationLayoutModel
 *   - applyTemplateContentToUi(): LLM-generated content dict -> hydrated slide UI
 */

import { extractIconTypeFromSettings } from "../utils/icon-weights.js";
import { normalizeLatex, parseLatexTags, replaceTextRuns } from "../utils/latex-text.js";
import type { PresentationLayoutModel, SlideLayoutModel } from "../utils/models.js";
import { hydrateRepeatedTopLevelGroups } from "./template-content.js";
import { getTemplateSchema } from "./template-schema.js";

const GENERATED_VALUE_ELEMENT_TYPES = new Set([
  "text", "math", "image", "text-list", "table", "chart",
]);

const GENERATED_TABLE_TEXT_FONT: Record<string, unknown> = {
  family: "Sniglet",
  size: 12,
  color: "#082314",
};
const GENERATED_TABLE_HEADER_FONT: Record<string, unknown> = {
  ...GENERATED_TABLE_TEXT_FONT,
  bold: true,
};
const GENERATED_TABLE_CELL_FILL: Record<string, unknown> = { color: "#F8F4E9", opacity: 1 };
const GENERATED_TABLE_CELL_STROKE: Record<string, unknown> = {
  color: "#D8D3C4",
  opacity: 1,
  width: 1,
};

const TEMPLATE_STRONG_MARKDOWN_DELIMITERS = ["**", "__"] as const;
const TEMPLATE_EMPHASIS_MARKDOWN_DELIMITERS = ["*", "_"] as const;
const TEMPLATE_MARKDOWN_DELIMITERS = [
  ...TEMPLATE_STRONG_MARKDOWN_DELIMITERS,
  ...TEMPLATE_EMPHASIS_MARKDOWN_DELIMITERS,
] as const;

// ── Public API ───────────────────────────────────────────────────────────────

export function templateReference(templateId: string): string {
  return templateId;
}

export function isTemplateLayoutPayload(layoutPayload: unknown): boolean {
  return (
    typeof layoutPayload === "object" &&
    layoutPayload !== null &&
    !Array.isArray(layoutPayload) &&
    Array.isArray((layoutPayload as Record<string, unknown>)["layouts"])
  );
}

export function templateSlideUi(
  layoutPayload: unknown,
  layoutId: string,
): Record<string, unknown> | null {
  if (!isTemplateLayoutPayload(layoutPayload)) return null;
  const payload = layoutPayload as Record<string, unknown>;
  const layouts = payload["layouts"] as unknown[];
  for (const layout of layouts) {
    if (
      typeof layout === "object" &&
      layout !== null &&
      !Array.isArray(layout) &&
      String((layout as Record<string, unknown>)["id"]) === String(layoutId)
    ) {
      return JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
    }
  }
  return null;
}

export function extractTemplateFontsFromAssets(
  assets: unknown,
): Record<string, string> | null {
  if (typeof assets !== "object" || assets === null || Array.isArray(assets)) return null;
  return coercePresentationFontMap((assets as Record<string, unknown>)["fonts"]);
}

export function coercePresentationFontMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fonts: Record<string, string> = {};
  for (const [name, url] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === "string" && typeof url === "string" && name.trim() && url.trim()) {
      fonts[name.trim()] = url.trim();
    }
  }
  return Object.keys(fonts).length > 0 ? fonts : null;
}

// ── Layout payload -> PresentationLayoutModel ────────────────────────────────

export function buildTemplateLayoutModel(
  layoutPayload: Record<string, unknown>,
  opts: { layout_name: string },
): PresentationLayoutModel {
  const templateSchema = getTemplateSchema(layoutPayload);

  const sourceLayouts = Array.isArray(layoutPayload["layouts"])
    ? (layoutPayload["layouts"] as unknown[])
    : [];

  const slides: SlideLayoutModel[] = [];
  const schemaLayouts = (templateSchema["layouts"] as unknown[]) ?? [];

  for (let index = 0; index < schemaLayouts.length; index++) {
    const schemaLayout = schemaLayouts[index];
    if (typeof schemaLayout !== "object" || schemaLayout === null || Array.isArray(schemaLayout)) {
      continue;
    }
    const sl = schemaLayout as Record<string, unknown>;
    const sourceLayout =
      index < sourceLayouts.length &&
      typeof sourceLayouts[index] === "object" &&
      sourceLayouts[index] !== null &&
      !Array.isArray(sourceLayouts[index])
        ? (sourceLayouts[index] as Record<string, unknown>)
        : {};

    const layoutId =
      sl["layout_id"] ?? sourceLayout["id"] ?? `layout_${index + 1}`;
    let layoutSchema = sl["schema"];
    if (typeof layoutSchema !== "object" || layoutSchema === null || Array.isArray(layoutSchema)) {
      layoutSchema = {
        title: String(layoutId),
        description: sourceLayout["description"],
      };
    }
    const ls = layoutSchema as Record<string, unknown>;

    slides.push({
      id: String(layoutId),
      name: (sourceLayout["name"] as string | undefined) ?? (ls["title"] as string | undefined),
      description:
        (sourceLayout["description"] as string | undefined) ??
        (ls["description"] as string | undefined),
      json_schema: ls,
    });
  }

  if (!slides.length) {
    throw new Error("Template layout JSON must contain at least one layout");
  }

  const iconType = extractIconTypeFromSettings(layoutPayload);
  return {
    name: opts.layout_name,
    ordered: false,
    icon_type: iconType,
    icon_weight: iconType,
    slides,
  };
}

// ── Generated content -> hydrated slide UI ───────────────────────────────────

export function hydrateTemplateSlideUi(
  slideUi: unknown,
  slideLayout: string,
  content: Record<string, unknown>,
  layoutPayload: unknown,
): unknown {
  if (!isTemplateLayoutPayload(layoutPayload)) return slideUi;
  const ui =
    typeof slideUi === "object" && slideUi !== null && !Array.isArray(slideUi)
      ? (slideUi as Record<string, unknown>)
      : templateSlideUi(layoutPayload, slideLayout);
  return applyTemplateContentToUi(ui, content);
}

function _templateComponentContentKeys(components: unknown[]): string[] {
  const ids: string[] = components.map((component, index) => {
    if (
      typeof component === "object" &&
      component !== null &&
      !Array.isArray(component) &&
      typeof (component as Record<string, unknown>)["id"] === "string"
    ) {
      return (component as Record<string, unknown>)["id"] as string;
    }
    return `component_${index}`;
  });

  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;

  const indexes: Record<string, number> = {};
  const used = new Set<string>();
  const keys: string[] = [];

  for (const componentId of ids) {
    const occurrenceIndex = indexes[componentId] ?? 0;
    indexes[componentId] = occurrenceIndex + 1;
    const base =
      (counts[componentId] ?? 0) > 1
        ? `${componentId}_${occurrenceIndex}`
        : componentId;
    let key = base;
    let suffix = 1;
    while (used.has(key)) { key = `${base}_${suffix}`; suffix++; }
    used.add(key);
    keys.push(key);
  }

  return keys;
}

export function applyTemplateContentToUi(
  ui: Record<string, unknown> | null,
  content: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) return ui ?? null;

  const components = ui["components"];
  if (!Array.isArray(components) || !components.length) return ui;

  const componentKeys = _templateComponentContentKeys(components);
  const hydratedUi = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
  const hydratedComponents = hydratedUi["components"];
  if (!Array.isArray(hydratedComponents)) return hydratedUi;

  for (let index = 0; index < hydratedComponents.length; index++) {
    const component = hydratedComponents[index];
    if (typeof component !== "object" || component === null || Array.isArray(component)) continue;
    const comp = component as Record<string, unknown>;

    const componentId = comp["id"];
    let componentContent = content[componentKeys[index]];
    if (
      typeof componentContent !== "object" ||
      componentContent === null ||
      Array.isArray(componentContent)
    ) {
      if (typeof componentId === "string") {
        componentContent = content[componentId];
      }
    }
    if (
      typeof componentContent !== "object" ||
      componentContent === null ||
      Array.isArray(componentContent)
    ) {
      componentContent = {};
    }
    const compContent = componentContent as Record<string, unknown>;

    const elements = comp["elements"];
    if (Array.isArray(elements)) {
      const repeatedGroups = hydrateRepeatedTopLevelGroups(
        elements,
        compContent,
        (element, item) =>
          _applyTemplateContentToElement(element, item, { directValue: true }),
      );
      comp["elements"] =
        repeatedGroups !== null
          ? repeatedGroups
          : _applyTemplateContentToElementList(elements, compContent);
    }
  }

  return hydratedUi;
}

// ── Element content application ──────────────────────────────────────────────

function _applyTemplateContentToElement(
  element: unknown,
  content: unknown,
  opts: {
    directValue?: boolean;
    preferredContentKeys?: string[] | null;
    nameOccurrences?: Record<string, number> | null;
  } = {},
): unknown {
  if (typeof element !== "object" || element === null || Array.isArray(element)) return element;
  const el = element as Record<string, unknown>;
  const { directValue = false, nameOccurrences = null } = opts;
  let { preferredContentKeys = null } = opts;

  const contentValues =
    typeof content === "object" && content !== null && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
  const elementType = el["type"];
  const name =
    typeof el["name"] === "string" ? (el["name"] as string) : null;

  let hasValue = false;
  let value: unknown = null;

  if (name) {
    if (preferredContentKeys === null && nameOccurrences !== null) {
      preferredContentKeys = _templateRepeatedContentKeysForName(name, contentValues, nameOccurrences);
    }
    [hasValue, value] = _templateContentValue(contentValues, name, preferredContentKeys);
  }

  if (
    el["decorative"] === false &&
    name &&
    hasValue &&
    typeof elementType === "string" &&
    GENERATED_VALUE_ELEMENT_TYPES.has(elementType)
  ) {
    return _applyTemplateContentValue(el, value);
  }

  if (
    directValue &&
    !hasValue &&
    el["decorative"] === false &&
    typeof elementType === "string" &&
    GENERATED_VALUE_ELEMENT_TYPES.has(elementType)
  ) {
    return _applyTemplateContentValue(el, content);
  }

  const nestedContent =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : contentValues;
  const nestedDirectValue = directValue && !hasValue;
  const nestedNameOccurrences =
    hasValue && typeof value === "object" && value !== null && !Array.isArray(value)
      ? {}
      : nameOccurrences;

  if (elementType === "container") {
    const updated = JSON.parse(JSON.stringify(el)) as Record<string, unknown>;
    updated["child"] = _applyTemplateContentToElement(el["child"], nestedContent, {
      directValue: nestedDirectValue,
      nameOccurrences: nestedNameOccurrences,
    });
    return updated;
  }

  if (elementType === "flex" || elementType === "grid" || elementType === "group") {
    const updated = JSON.parse(JSON.stringify(el)) as Record<string, unknown>;
    const children = Array.isArray(el["children"]) ? (el["children"] as unknown[]) : [];
    updated["children"] = _applyTemplateContentToChildren(children, value, nestedContent, {
      directValue: nestedDirectValue,
      nameOccurrences: nestedNameOccurrences,
    });
    return updated;
  }

  return JSON.parse(JSON.stringify(el));
}

function _templateContentValue(
  content: Record<string, unknown>,
  name: string,
  preferredKeys: string[] | null,
): [boolean, unknown] {
  const candidates: string[] = [];
  for (const candidate of [...(preferredKeys ?? []), ..._templateContentNameCandidates(name)]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    if (candidate in content) return [true, content[candidate]];
  }
  return [false, null];
}

function _templateContentNameCandidates(name: string): string[] {
  const withoutNumericToken = name.replace(/_\d+(?=_|$)/g, "");
  const withoutPrefix = withoutNumericToken.includes("_")
    ? withoutNumericToken.split("_").slice(1).join("_")
    : withoutNumericToken;

  const candidates: string[] = [];
  for (const candidate of [name, withoutNumericToken, withoutPrefix]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function _applyTemplateContentToChildren(
  children: unknown[],
  value: unknown,
  content: unknown,
  opts: { directValue?: boolean; nameOccurrences?: Record<string, number> | null } = {},
): unknown[] {
  if (Array.isArray(value) && children.length) {
    return value.map((item, index) =>
      _applyTemplateContentToElement(
        children[Math.min(index, children.length - 1)],
        item,
        { directValue: true },
      ),
    );
  }
  return _applyTemplateContentToElementList(children, content, opts);
}

function _applyTemplateContentToElementList(
  elements: unknown[],
  content: unknown,
  opts: { directValue?: boolean; nameOccurrences?: Record<string, number> | null } = {},
): unknown[] {
  const { directValue = false, nameOccurrences = null } = opts;
  const scopedOccurrences = nameOccurrences ?? {};
  return elements.map((element) =>
    _applyTemplateContentToElement(element, content, {
      directValue,
      nameOccurrences: scopedOccurrences,
    }),
  );
}

function _templateRepeatedContentKeysForName(
  name: string,
  content: Record<string, unknown>,
  nameOccurrences: Record<string, number>,
): string[] | null {
  const occurrenceIndex = nameOccurrences[name] ?? 0;
  nameOccurrences[name] = occurrenceIndex + 1;
  if (occurrenceIndex === 0) return null;
  const suffixedKey = `${name}_${occurrenceIndex + 1}`;
  return suffixedKey in content ? [suffixedKey] : null;
}

function _applyTemplateContentValue(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const elementType = element["type"];
  if (elementType === "text") return _applyTemplateTextContent(element, value);
  if (elementType === "math") return _applyTemplateMathContent(element, value);
  if (elementType === "image") return _applyTemplateImageContent(element, value);
  if (elementType === "text-list") return _applyTemplateTextListContent(element, value);
  if (elementType === "table") return _applyTemplateTableContent(element, value);
  if (elementType === "chart") return _applyTemplateChartContent(element, value);
  return JSON.parse(JSON.stringify(element));
}

function _applyTemplateMathContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const latex = _readTemplateText(value);
  if (latex === null || latex.trim() === "") return JSON.parse(JSON.stringify(element));
  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  updated["latex"] = normalizeLatex(latex);
  return updated;
}

function _readTemplateText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const text = record["text"];
    if (typeof text === "string") return text;
    if (typeof text === "number") return String(text);
  }
  return null;
}

function _applyTemplateTextContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const text = _readTemplateText(value);
  if (text === null || text === "") return JSON.parse(JSON.stringify(element));
  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  const firstRun = _firstTemplateTextRun(element["runs"]);
  updated["runs"] = _templateTextRunsFromMarkdown(text, firstRun, element["font"]);
  delete updated["text"];
  return updated;
}

function _applyTemplateImageContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.parse(JSON.stringify(element));
  }
  const valueRecord = value as Record<string, unknown>;

  let url: string | null = null;
  for (const key of ["image_url", "icon_url", "__image_url__", "__icon_url__", "url"]) {
    const candidate = valueRecord[key];
    if (typeof candidate === "string" && candidate) { url = candidate; break; }
  }
  if (!url) return JSON.parse(JSON.stringify(element));

  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  updated["data"] = url;
  _normalizeGeneratedImageFit(updated, url);
  const prompt = _templateAssetPrompt(value, element["is_icon"] === true);
  if (prompt) updated["prompt"] = prompt;
  return updated;
}

function _normalizeGeneratedImageFit(element: Record<string, unknown>, assetUrl: string | null): void {
  if (element["is_icon"] === true || element["fit"] === "cover") return;
  if (_hasImageClipPath(element)) return;
  if (_looksLikeSvgAssetReference(assetUrl)) return;
  element["fit"] = "cover";
}

function _hasImageClipPath(element: Record<string, unknown>): boolean {
  for (const key of ["clip_path", "clipPath", "clippath"]) {
    const value = element[key];
    if (typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "none") {
      return true;
    }
  }
  return false;
}

function _looksLikeSvgAssetReference(value: string | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("data:image/svg+xml")) return true;
  return normalized.split("?")[0].split("#")[0].endsWith(".svg");
}

function _templateAssetPrompt(value: unknown, isIcon: boolean): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const promptKeys = isIcon
    ? (["icon_query", "__icon_query__", "query", "prompt"] as const)
    : (["image_prompt", "__image_prompt__", "prompt", "query"] as const);
  for (const key of promptKeys) {
    const prompt = record[key];
    if (typeof prompt === "string" && prompt.trim()) return prompt;
  }
  return null;
}

function _applyTemplateTextListContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  if (!Array.isArray(value)) return JSON.parse(JSON.stringify(element));

  const existingItems = Array.isArray(element["items"]) ? (element["items"] as unknown[]) : [];
  const items: unknown[] = [];

  for (let index = 0; index < value.length; index++) {
    const text = _readTemplateText(value[index]);
    if (text !== null && text !== "") {
      const existingRuns =
        index < existingItems.length && Array.isArray(existingItems[index])
          ? (existingItems[index] as unknown[])
          : null;
      const firstRun =
        Array.isArray(existingRuns) &&
        existingRuns.length > 0 &&
        typeof existingRuns[0] === "object" &&
        existingRuns[0] !== null
          ? (existingRuns[0] as Record<string, unknown>)
          : {};
      items.push(_templateTextRunsFromMarkdown(text, firstRun, element["font"]));
    }
  }

  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  updated["items"] = items;
  return updated;
}

function _applyTemplateTableContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.parse(JSON.stringify(element));
  }
  const valueRecord = value as Record<string, unknown>;

  const templateColumns = Array.isArray(element["columns"])
    ? (element["columns"] as unknown[])
    : [];
  const templateRows = (Array.isArray(element["rows"]) ? (element["rows"] as unknown[]) : []).filter(
    (row) => Array.isArray(row),
  );

  const generatedColumns = Array.isArray(valueRecord["columns"])
    ? (valueRecord["columns"] as unknown[]).map(_readTemplateTableText)
    : [];
  const generatedRows = Array.isArray(valueRecord["rows"])
    ? (valueRecord["rows"] as unknown[])
        .filter((row) => Array.isArray(row))
        .map((row) => (row as unknown[]).map(_readTemplateTableText))
    : [];

  const fallbackRow = templateRows.length > 0 ? templateRows[templateRows.length - 1] : templateColumns;

  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  updated["columns"] = generatedColumns.length
    ? _mergeTemplateTableRowToLength(templateColumns, generatedColumns, true)
    : JSON.parse(JSON.stringify(templateColumns));
  updated["rows"] = generatedRows.length
    ? generatedRows.map((row, index) =>
        _mergeTemplateTableRowToLength(
          index < templateRows.length ? (templateRows[index] as unknown[]) : (fallbackRow as unknown[]),
          row,
          false,
        ),
      )
    : JSON.parse(JSON.stringify(templateRows));
  return updated;
}

function _mergeTemplateTableRowToLength(
  templateCells: unknown[],
  generatedTexts: (string | null)[],
  isHeader: boolean,
): unknown[] {
  const fallbackCell = templateCells.length > 0 ? templateCells[templateCells.length - 1] : null;
  return generatedTexts.map((text, index) =>
    _replaceTemplateTableCellText(
      index < templateCells.length ? templateCells[index] : fallbackCell,
      text ?? "",
      isHeader,
    ),
  );
}

function _replaceTemplateTableCellText(
  cell: unknown,
  text: string,
  isHeader: boolean,
): Record<string, unknown> {
  const font = isHeader ? GENERATED_TABLE_HEADER_FONT : GENERATED_TABLE_TEXT_FONT;
  if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
    return {
      color: GENERATED_TABLE_CELL_FILL,
      stroke: GENERATED_TABLE_CELL_STROKE,
      font,
      runs: _templateTextRunsFromMarkdown(text, { font }),
    };
  }
  const cellRecord = cell as Record<string, unknown>;
  const updated = JSON.parse(JSON.stringify(cellRecord)) as Record<string, unknown>;
  const firstRun = _firstTemplateTextRun(cellRecord["runs"]);
  const runFont =
    typeof firstRun["font"] === "object" && firstRun["font"] !== null && !Array.isArray(firstRun["font"])
      ? (firstRun["font"] as Record<string, unknown>)
      : null;
  const nextFont = runFont ?? cellRecord["font"] ?? font;
  updated["color"] = cellRecord["color"] ?? cellRecord["fill"] ?? GENERATED_TABLE_CELL_FILL;
  updated["stroke"] = cellRecord["stroke"] ?? GENERATED_TABLE_CELL_STROKE;
  updated["font"] = cellRecord["font"] ?? nextFont;
  updated["runs"] = _templateTextRunsFromMarkdown(text, firstRun, nextFont);
  delete updated["text"];
  delete updated["fill"];
  return updated;
}

function _readTemplateTableText(value: unknown): string | null {
  const primitiveText = _readTemplatePrimitiveTableText(value);
  if (primitiveText !== null) return primitiveText.slice(0, 80);

  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const runs = record["runs"];
  if (Array.isArray(runs)) {
    const runText = runs
      .filter(
        (run): run is Record<string, unknown> =>
          typeof run === "object" && run !== null && !Array.isArray(run) && typeof (run as Record<string, unknown>)["text"] === "string",
      )
      .map((run) => (run as Record<string, unknown>)["text"] as string)
      .join("");
    if (runText) return runText.slice(0, 80);
  }

  for (const key of ["text", "value"]) {
    const text = _readTemplatePrimitiveTableText(record[key]);
    if (text !== null) return text.slice(0, 80);
  }

  return null;
}

function _readTemplatePrimitiveTableText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value).toLowerCase();
  if (typeof value === "number") return String(value);
  return null;
}

function _readTemplateDataLabels(value: unknown): string | null {
  if (value === true) return "top";
  if (value === false || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["base", "mid", "top", "outside"].includes(normalized)) return normalized;
  }
  return null;
}

function _applyTemplateChartContent(
  element: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const updated = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
  delete updated["data_labels_color"];
  delete updated["grid"];

  if (typeof value !== "object" || value === null || Array.isArray(value)) return updated;
  const valueRecord = value as Record<string, unknown>;

  const chartType = valueRecord["chartType"] ?? valueRecord["chart_type"];
  if (
    typeof chartType === "string" &&
    [
      "area", "bar", "bubble", "donut", "horizontal_bar", "horizontal_stacked_bar",
      "line", "pie", "polar_area", "radar", "scatter", "stacked_bar",
    ].includes(chartType)
  ) {
    updated["chart_type"] = chartType;
  }

  if (typeof valueRecord["title"] === "string") updated["title"] = valueRecord["title"];
  if (Array.isArray(valueRecord["categories"]) && (valueRecord["categories"] as unknown[]).length) {
    updated["categories"] = valueRecord["categories"];
  }
  if (Array.isArray(valueRecord["series"]) && (valueRecord["series"] as unknown[]).length) {
    updated["series"] = valueRecord["series"];
  }

  const colors = valueRecord["colors"];
  if (Array.isArray(colors) && colors.length) updated["colors"] = colors;

  for (const [sourceKey, targetKey] of [
    ["axisColor", "axis_color"], ["axis_color", "axis_color"],
    ["gridColor", "grid_color"], ["grid_color", "grid_color"],
    ["legendColor", "legend_color"], ["legend_color", "legend_color"],
    ["xAxisTitle", "x_axis_title"], ["x_axis_title", "x_axis_title"],
    ["yAxisTitle", "y_axis_title"], ["y_axis_title", "y_axis_title"],
    ["source", "source"],
  ] as [string, string][]) {
    if (typeof valueRecord[sourceKey] === "string") updated[targetKey] = valueRecord[sourceKey];
  }

  for (const [sourceKey, targetKey] of [
    ["xAxis", "x_axis"], ["x_axis", "x_axis"],
    ["yAxis", "y_axis"], ["y_axis", "y_axis"],
    ["xAxisGrid", "x_axis_grid"], ["x_axis_grid", "x_axis_grid"],
    ["yAxisGrid", "y_axis_grid"], ["y_axis_grid", "y_axis_grid"],
  ] as [string, string][]) {
    if (typeof valueRecord[sourceKey] === "boolean") updated[targetKey] = valueRecord[sourceKey];
  }

  for (const sourceKey of ["dataLabels", "data_labels"]) {
    if (sourceKey in valueRecord) {
      updated["data_labels"] = _readTemplateDataLabels(valueRecord[sourceKey]);
    }
  }

  return updated;
}

// ── Text run helpers ─────────────────────────────────────────────────────────

function _firstTemplateTextRun(runs: unknown): Record<string, unknown> {
  if (Array.isArray(runs) && runs.length > 0 && typeof runs[0] === "object" && runs[0] !== null) {
    return runs[0] as Record<string, unknown>;
  }
  return {};
}

function _templateTextRunsFromMarkdown(
  text: string,
  firstRun: unknown,
  fallbackFont: unknown = null,
): Record<string, unknown>[] {
  if (
    parseLatexTags(text) !== null ||
    (typeof firstRun === "object" &&
      firstRun !== null &&
      !Array.isArray(firstRun) &&
      (firstRun as Record<string, unknown>)["type"] === "latex")
  ) {
    return replaceTextRuns(
      typeof firstRun === "object" && firstRun !== null ? [firstRun as Record<string, unknown>] : null,
      text,
      fallbackFont,
    );
  }

  let baseRun =
    typeof firstRun === "object" && firstRun !== null && !Array.isArray(firstRun)
      ? (JSON.parse(JSON.stringify(firstRun)) as Record<string, unknown>)
      : {};
  const parsed = _parseTemplateMarkdownText(text);
  const hasMarkdownStyle = parsed.some(([, style]) => Object.keys(style).length > 0);
  baseRun = _templateBaseRunForMarkdown(baseRun, fallbackFont, hasMarkdownStyle);

  const textRuns: Record<string, unknown>[] = [];
  for (const [parsedText, style] of parsed) {
    const run = JSON.parse(JSON.stringify(baseRun)) as Record<string, unknown>;
    run["text"] = parsedText;
    if (Object.keys(style).length > 0) {
      const font = run["font"];
      run["font"] = {
        ...(typeof font === "object" && font !== null && !Array.isArray(font)
          ? (JSON.parse(JSON.stringify(font)) as Record<string, unknown>)
          : {}),
        ...style,
      };
    }
    _appendTemplateTextRun(textRuns, run);
  }

  if (textRuns.length) return textRuns;
  return [{ ...baseRun, text: " " }];
}

function _templateBaseRunForMarkdown(
  baseRun: Record<string, unknown>,
  fallbackFont: unknown,
  stripInlineEmphasis: boolean,
): Record<string, unknown> {
  const font = baseRun["font"];
  if (typeof fallbackFont === "object" && fallbackFont !== null && !Array.isArray(fallbackFont)) {
    const mergedFont = {
      ...(JSON.parse(JSON.stringify(fallbackFont)) as Record<string, unknown>),
      ...(typeof font === "object" && font !== null && !Array.isArray(font)
        ? (JSON.parse(JSON.stringify(font)) as Record<string, unknown>)
        : {}),
    };
    baseRun["font"] = mergedFont;
  } else if (typeof font === "object" && font !== null && !Array.isArray(font)) {
    baseRun["font"] = JSON.parse(JSON.stringify(font)) as Record<string, unknown>;
  }

  if (
    stripInlineEmphasis &&
    typeof baseRun["font"] === "object" &&
    baseRun["font"] !== null &&
    !Array.isArray(baseRun["font"])
  ) {
    const f = baseRun["font"] as Record<string, unknown>;
    delete f["bold"];
    delete f["italic"];
  }

  return baseRun;
}

function _parseTemplateMarkdownText(text: string): [string, Record<string, boolean>][] {
  const parsed: [string, Record<string, boolean>][] = [];
  let index = 0;

  while (index < text.length) {
    const strongDelimiter = _templateReadMarkdownDelimiter(
      text,
      index,
      TEMPLATE_STRONG_MARKDOWN_DELIMITERS,
    );
    if (strongDelimiter) {
      const close = text.indexOf(strongDelimiter, index + strongDelimiter.length);
      if (close > index + strongDelimiter.length) {
        parsed.push([text.slice(index + strongDelimiter.length, close), { bold: true }]);
        index = close + strongDelimiter.length;
        continue;
      }
    }

    const emphasisDelimiter = _templateReadMarkdownDelimiter(
      text,
      index,
      TEMPLATE_EMPHASIS_MARKDOWN_DELIMITERS,
    );
    if (emphasisDelimiter) {
      const close = text.indexOf(emphasisDelimiter, index + emphasisDelimiter.length);
      if (close > index + emphasisDelimiter.length) {
        parsed.push([text.slice(index + emphasisDelimiter.length, close), { italic: true }]);
        index = close + emphasisDelimiter.length;
        continue;
      }
    }

    const nextIndex = _templateNextMarkdownDelimiterIndex(text, index + 1);
    parsed.push([nextIndex === -1 ? text.slice(index) : text.slice(index, nextIndex), {}]);
    index = nextIndex === -1 ? text.length : nextIndex;
  }

  return parsed;
}

function _templateReadMarkdownDelimiter(
  text: string,
  index: number,
  delimiters: readonly string[],
): string | null {
  for (const delimiter of delimiters) {
    if (text.startsWith(delimiter, index)) return delimiter;
  }
  return null;
}

function _templateNextMarkdownDelimiterIndex(text: string, start: number): number {
  const indexes = TEMPLATE_MARKDOWN_DELIMITERS.map((d) => text.indexOf(d, start)).filter(
    (i) => i !== -1,
  );
  return indexes.length ? Math.min(...indexes) : -1;
}

function _appendTemplateTextRun(
  textRuns: Record<string, unknown>[],
  run: Record<string, unknown>,
): void {
  const text = run["text"];
  if (typeof text !== "string" || text === "") return;

  const previous = textRuns.length > 0 ? textRuns[textRuns.length - 1] : null;
  if (previous !== null) {
    const previousStyle = Object.fromEntries(
      Object.entries(previous).filter(([k]) => k !== "text"),
    );
    const nextStyle = Object.fromEntries(Object.entries(run).filter(([k]) => k !== "text"));
    if (
      JSON.stringify(previousStyle) === JSON.stringify(nextStyle) &&
      typeof previous["text"] === "string"
    ) {
      previous["text"] += text;
      return;
    }
  }

  textRuns.push(run);
}
