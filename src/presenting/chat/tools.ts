/**
 * ChatTools — LLM tool registry + executor for presentation editing.
 * Port of presenting/engine/services/chat/tools.py (ChatTools class).
 */

import { loadsJsonish } from "../utils/jsonish.js";
import { MAX_NUMBER_OF_SLIDES } from "../utils/models.js";
import { MAX_OUTLINE_CONTENT_WORDS } from "../utils/outline-limits.js";
import type { PresentationContextStore } from "../db/presentation-context.js";
import type { Tool, ToolCall } from "./llm-tool-types.js";
import {
  type AddOutlineInput,
  type UpdateOutlineInput,
  type DeleteOutlineInput,
  type AddNewSlideInput,
  type AddNewSlideLayoutInput,
  type SaveSlideInput,
  type SaveSmartSlideInput,
  type UpdateSlideInput,
  type DeleteSlideInput,
  type GetSlideAtIndexInput,
  type GetSmartPresentationContextInput,
  type SearchSlidesInput,
  type ReadSourceDocumentsInput,
  type GetContentSchemaFromLayoutIdInput,
  type GetAvailableBlocksInput,
  type GenerateAssetsInput,
  type AddElementInput,
  type UpdateSlideElementInput,
  type UpdateSlideComponentInput,
  type UpdateComponentInput,
  type AddSlideComponentInput,
  type DeleteSlideComponentInput,
  type DeleteSlideElementInput,
  type SetPresentationThemeInput,
  normalizeUpdateElementArgs,
  normalizeComponentId,
  parseSlideContent,
} from "./schemas.js";

export type ChatToolMode = "presentation" | "outline";

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const MAX_TOOL_REPAIR_RETRIES = 1;

const CHART_INSERT_TOOL_FIELDS: Record<string, string> = {
  addElement: "element",
  addComponent: "component",
  createComponent: "component",
  updateComponent: "component",
};
const TABLE_INSERT_TOOL_FIELDS = CHART_INSERT_TOOL_FIELDS;
const IMAGE_INSERT_TOOL_FIELDS = CHART_INSERT_TOOL_FIELDS;
const BLOCK_PRIORITIZED_INSERT_TYPES = new Set(["chart", "table"]);

const JSON_OBJECT_STRING_FIELDS: Record<string, string[]> = {
  addNewSlideLayout: ["content"],
  saveSlide: ["content"],
  updateSlide: ["content"],
  addElement: ["element"],
  updateElement: ["element"],
  addComponent: ["component"],
  createComponent: ["component"],
  updateComponent: ["component"],
};

function normalizeArgValue(value: unknown): unknown {
  if (typeof value === "string" && value.trim().toLowerCase() === "null") return null;
  if (Array.isArray(value)) return value.map(normalizeArgValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeArgValue(v)]));
  }
  return value;
}

export class ChatTools {
  private readonly _memory: PresentationContextStore;
  private readonly _mode: ChatToolMode;
  private _turnUserMessage = "";
  private _generatedAssets: Array<{ kind: string; prompt: string; url: string }> = [];
  private readonly _toolHandlers: Record<string, ToolHandler>;

  constructor(memory: PresentationContextStore, mode: ChatToolMode = "presentation") {
    this._memory = memory;
    this._mode = mode;
    this._toolHandlers = {
      addOutline: this._addOutline.bind(this),
      updateOutline: this._updateOutline.bind(this),
      deleteOutline: this._deleteOutline.bind(this),
      addNewSlide: this._addNewSlide.bind(this),
      addNewSlideLayout: this._addNewSlideLayout.bind(this),
      getTemplateSummary: this._getTemplateSummary.bind(this),
      getSmartPresentationContext: this._getSmartPresentationContext.bind(this),
      readSourceDocuments: this._readSourceDocuments.bind(this),
      searchSlide: this._searchSlides.bind(this),
      getSlideAtIndex: this._getSlideAtIndex.bind(this),
      getAvailableLayouts: this._getAvailableLayouts.bind(this),
      getAvailableBlocks: this._getAvailableBlocks.bind(this),
      getContentSchemaFromLayoutId: this._getContentSchemaFromLayoutId.bind(this),
      generateAssets: this._generateAssets.bind(this),
      saveSlide: this._saveSlide.bind(this),
      updateSlide: this._updateSlide.bind(this),
      deleteSlide: this._deleteSlide.bind(this),
      addElement: this._addElement.bind(this),
      updateElement: this._updateSlideElement.bind(this),
      deleteElement: this._deleteSlideElement.bind(this),
      addComponent: this._addSlideComponent.bind(this),
      createComponent: this._addSlideComponent.bind(this),
      updateComponent: this._updateComponent.bind(this),
      deleteComponent: this._deleteSlideComponent.bind(this),
      getPresentationTheme: this._getPresentationThemeCatalog.bind(this),
      setPresentationTheme: this._setPresentationTheme.bind(this),
    };
  }

  setTurnContext(userMessage: string): void {
    this._turnUserMessage = userMessage ?? "";
    this._generatedAssets = [];
  }

  getToolDefinitions(): Tool[] {
    if (this._memory.presentationType === "smart") return this._getSmartToolDefinitions();
    return [
      { name: "addOutline", description: `Insert a new markdown outline item. Do not exceed ${MAX_NUMBER_OF_SLIDES} outline slides or ${MAX_OUTLINE_CONTENT_WORDS} words per item.`, parameters: { type: "object", properties: { content: { type: "string" }, index: { type: ["integer", "null"] } }, required: ["content"] } },
      { name: "updateOutline", description: `Replace the markdown content of one outline item by zero-based index. Keep within ${MAX_OUTLINE_CONTENT_WORDS} words.`, parameters: { type: "object", properties: { index: { type: "integer" }, content: { type: "string" } }, required: ["index", "content"] } },
      { name: "deleteOutline", description: "Delete one outline item by zero-based index.", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
      { name: "addNewSlide", description: "Add a blank slide at a zero-based index (null = append).", parameters: { type: "object", properties: { index: { type: ["integer", "null"] } } } },
      { name: "addNewSlideLayout", description: "Add a new slide from an available layout. Use getAvailableLayouts first.", parameters: { type: "object", properties: { layoutId: { type: "string" }, content: { type: "string" }, index: { type: ["integer", "null"] } }, required: ["layoutId", "content"] } },
      { name: "getAvailableLayouts", description: "List available slide layout ids, names, and summaries.", parameters: { type: "object", properties: {} } },
      { name: "getAvailableBlocks", description: "Search reusable template component blocks. Use before addComponent/createComponent for table, chart, card, metric, or callout additions.", parameters: { type: "object", properties: { query: { type: ["string", "null"] }, layoutId: { type: ["string", "null"] }, elementType: { type: ["string", "null"] }, blockId: { type: ["string", "null"] }, includeFullContent: { type: ["boolean", "null"] }, maxResults: { type: ["integer", "null"] } } } },
      { name: "getContentSchemaFromLayoutId", description: "Return the exact JSON content schema for one layout id. Use before addNewSlideLayout or updateSlide.", parameters: { type: "object", properties: { layoutId: { type: "string" } }, required: ["layoutId"] } },
      { name: "getTemplateSummary", description: "Read a compact summary of the current presentation template, layouts, slides, and theme.", parameters: { type: "object", properties: {} } },
      { name: "readSourceDocuments", description: "Read parsed text from uploaded source documents. Use when the user refers to an uploaded PDF, document, or file.", parameters: { type: "object", properties: { query: { type: ["string", "null"] }, maxChars: { type: ["integer", "null"] } } } },
      { name: "searchSlide", description: "Search current slides for text/topics and return slide indices and snippets.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: ["integer", "null"] } }, required: ["query"] } },
      { name: "getSlideAtIndex", description: "Get one slide by zero-based index. Set includeFullContent=true for full JSON (before saveSlide or precise edits).", parameters: { type: "object", properties: { index: { type: "integer" }, includeFullContent: { type: ["boolean", "null"] } }, required: ["index"] } },
      { name: "saveSlide", description: "Save full slide content for a layout. Use for complete slide payloads.", parameters: { type: "object", properties: { content: { type: "string" }, layoutId: { type: "string" }, index: { type: "integer" }, replaceOldSlideAtIndex: { type: ["boolean", "null"] } }, required: ["content", "layoutId", "index"] } },
      { name: "updateSlide", description: "Replace an existing slide's layout/content by zero-based index.", parameters: { type: "object", properties: { content: { type: "string" }, layoutId: { type: "string" }, index: { type: "integer" } }, required: ["content", "layoutId", "index"] } },
      { name: "deleteSlide", description: "Delete an existing slide by zero-based index.", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
      { name: "addElement", description: "Add one rendered UI element to a slide. Chart elements need categories + series.values, images need a URL from generateAssets.", parameters: { type: "object", properties: { index: { type: "integer" }, element: { type: "string" }, componentId: { type: ["string", "null"] }, insertIndex: { type: ["integer", "null"] } }, required: ["index", "element"] } },
      { name: "updateElement", description: "Update visible element content or geometry using an elementPath from getSlideAtIndex.", parameters: { type: "object", properties: { index: { type: "integer" }, elementPath: { type: "string" }, text: { type: ["string", "null"] }, items: { type: ["array", "null"], items: { type: "string" } }, element: { type: ["string", "null"] }, tableCell: { type: ["object", "null"] }, table: { type: ["object", "null"] }, chart: { type: ["object", "null"] }, vector: { type: ["object", "null"] }, infographic: { type: ["object", "null"] }, position: { type: ["object", "null"] }, size: { type: ["object", "null"] }, font: { type: ["object", "null"] }, alignment: { type: ["object", "null"] }, fill: { type: ["object", "null"] }, stroke: { type: ["object", "null"] }, color: { type: ["string", "null"] }, opacity: { type: ["number", "null"] } }, required: ["index", "elementPath"] } },
      { name: "deleteElement", description: "Delete one rendered UI element by elementPath.", parameters: { type: "object", properties: { index: { type: "integer" }, elementPath: { type: "string" } }, required: ["index", "elementPath"] } },
      { name: "addComponent", description: "Add an existing/new rendered UI component block to a slide. For styled blocks, use getAvailableBlocks first.", parameters: { type: "object", properties: { index: { type: "integer" }, component: { type: "string" }, insertIndex: { type: ["integer", "null"] }, sourceBlockId: { type: ["string", "null"] } }, required: ["index", "component"] } },
      { name: "createComponent", description: "Create a grouped rendered UI component from provided component JSON.", parameters: { type: "object", properties: { index: { type: "integer" }, component: { type: "string" }, insertIndex: { type: ["integer", "null"] }, sourceBlockId: { type: ["string", "null"] } }, required: ["index", "component"] } },
      { name: "updateComponent", description: "Move, resize, replace, duplicate, reorder or delete rendered UI components by componentId.", parameters: { type: "object", properties: { index: { type: "integer" }, componentId: { type: "string" }, action: { type: ["string", "null"] }, component: { type: ["string", "null"] }, componentIds: { type: ["array", "null"] }, position: { type: ["object", "null"] }, size: { type: ["object", "null"] } }, required: ["index", "componentId"] } },
      { name: "deleteComponent", description: "Remove one whole component from a rendered slide by componentId.", parameters: { type: "object", properties: { index: { type: "integer" }, componentId: { type: "string" } }, required: ["index", "componentId"] } },
      { name: "getPresentationTheme", description: "Read the current presentation theme and available themes.", parameters: { type: "object", properties: {} } },
      { name: "setPresentationTheme", description: "Change the deck theme by theme name/id/query or customTheme payload.", parameters: { type: "object", properties: { theme: { type: ["string", "null"] }, customTheme: { type: ["object", "null"] }, saveCustomTheme: { type: ["boolean", "null"] } } } },
      { name: "generateAssets", description: "Generate one or more image/icon assets for slide edits.", parameters: { type: "object", properties: { assets: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["image", "icon"] }, prompt: { type: "string" } }, required: ["kind", "prompt"] } } }, required: ["assets"] } },
    ];
  }

  private _getSmartToolDefinitions(): Tool[] {
    return [
      { name: "getSmartPresentationContext", description: "Read Smart deck metadata, fonts, outlines, structure, and live HTML slide previews.", parameters: { type: "object", properties: { includeSlideHtml: { type: ["boolean", "null"] }, maxHtmlCharsPerSlide: { type: ["integer", "null"] } } } },
      { name: "readSourceDocuments", description: "Read parsed source documents for this presentation.", parameters: { type: "object", properties: { query: { type: ["string", "null"] }, maxChars: { type: ["integer", "null"] } } } },
      { name: "searchSlide", description: "Search rendered Smart slide text.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: ["integer", "null"] } }, required: ["query"] } },
      { name: "getSlideAtIndex", description: "Read one live Smart HTML slide by zero-based index.", parameters: { type: "object", properties: { index: { type: "integer" }, includeFullContent: { type: ["boolean", "null"] } }, required: ["index"] } },
      { name: "generateAssets", description: "Generate image or icon assets for Smart slide HTML.", parameters: { type: "object", properties: { assets: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["image", "icon"] }, prompt: { type: "string" } }, required: ["kind", "prompt"] } } }, required: ["assets"] } },
      { name: "saveSlide", description: "Replace or insert one Smart HTML slide via html field.", parameters: { type: "object", properties: { html: { type: "string" }, index: { type: "integer" }, replaceOldSlideAtIndex: { type: ["boolean", "null"] }, speakerNote: { type: ["string", "null"] } }, required: ["html", "index"] } },
      { name: "deleteSlide", description: "Delete a Smart slide by zero-based index.", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
    ];
  }

  async executeToolCall(toolCall: ToolCall): Promise<Record<string, unknown>> {
    const handler = this._toolHandlers[toolCall.name];
    if (!handler) {
      return {
        ok: false, tool: toolCall.name,
        error: `Unsupported tool: ${toolCall.name}`,
        recovery: { retryable: false, message: "Use one of the available chat tools.", guidance: ["Choose a tool from the tool definitions."] },
      };
    }

    let parsedArgs: Record<string, unknown> | null = null;
    const repairNotes: string[] = [];
    try {
      parsedArgs = this._parseArgs(toolCall.arguments ?? null);
      const [repairedArgs, notes] = this._repairToolArgs(toolCall.name, parsedArgs);
      parsedArgs = repairedArgs;
      repairNotes.push(...notes);

      let result: Record<string, unknown>;
      try {
        result = await handler(parsedArgs);
      } catch (firstExc) {
        let retried = false;
        for (let attempt = 0; attempt < MAX_TOOL_REPAIR_RETRIES; attempt++) {
          const [retryArgs, retryNotes] = this._repairToolArgs(toolCall.name, parsedArgs, String(firstExc));
          if (!retryNotes.length || argsEquivalent(parsedArgs, retryArgs)) break;
          repairNotes.push(...retryNotes);
          parsedArgs = retryArgs;
          result = await handler(parsedArgs);
          retried = true;
          break;
        }
        if (!retried) throw firstExc;
      }

      if (toolCall.name === "generateAssets") this._rememberGeneratedAssets(result!);
      const response: Record<string, unknown> = { ok: true, tool: toolCall.name, result: result! };
      if (repairNotes.length) response.repair = { applied: true, notes: repairNotes };
      return response;
    } catch (exc) {
      return {
        ok: false, tool: toolCall.name, error: String(exc),
        repair: { attempted: repairNotes.length > 0, notes: repairNotes },
        recovery: this._buildToolRecovery({ toolName: toolCall.name, args: parsedArgs, error: String(exc) }),
      };
    }
  }

  // ── Tool Handlers ─────────────────────────────────────────────────────────

  private async _getPresentationOutline(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const outline = await this._memory.get("presentation_outline");
    if (!outline || typeof outline !== "object") {
      return { found: false, message: "Presentation outline is not available.", sections: [] };
    }
    const raw = outline as Record<string, unknown>;
    const slides = Array.isArray(raw.slides) ? raw.slides : [];
    const sections = slides.map((slide, position) => {
      let index = position;
      let content = "";
      if (typeof slide === "string") { content = slide; }
      else if (slide && typeof slide === "object") {
        const s = slide as Record<string, unknown>;
        if (typeof s.index === "number") index = s.index;
        if (typeof s.content === "string") content = s.content;
        else if (s.content != null) content = JSON.stringify(s.content);
      }
      const title = extractTitle(content) || `Slide ${index + 1}`;
      return { index, slide_number: index + 1, title };
    });
    return { found: true, slide_count: sections.length, sections, source: raw.source ?? "memory" };
  }

  private async _searchSlides(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(args.query ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 5;
    const results = await this._memory.search(query, limit);
    return { query, count: results.length, results };
  }

  private async _getSlideAtIndex(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = Number(args.index ?? 0);
    const includeFullContent = Boolean(args.includeFullContent ?? false);
    let slide = await this._memory.getSlideAtIndex(index, includeFullContent);
    if (!slide && index > 0) {
      const fallbackIndex = index - 1;
      const fallback = await this._memory.getSlideAtIndex(fallbackIndex, includeFullContent);
      if (fallback) {
        return { found: true, slide: fallback, requested_index: index, resolved_index: fallbackIndex, note: `No slide at requested index; returned one-based fallback at index ${fallbackIndex}.` };
      }
    }
    if (!slide) return { found: false, message: `No slide found at index ${index}.` };
    return { found: true, slide };
  }

  private async _addOutline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const content = String(args.content ?? "");
    const index = args.index != null ? Number(args.index) : null;
    return this._memory.addOutline(content, index);
  }

  private async _updateOutline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = Number(args.index ?? 0);
    const content = String(args.content ?? "");
    return this._memory.updateOutline(index, content);
  }

  private async _deleteOutline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.deleteOutline(Number(args.index ?? 0));
  }

  private async _addNewSlide(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = args.index != null ? Number(args.index) : null;
    return this._memory.addBlankSlide(index);
  }

  private async _addNewSlideLayout(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const layoutId = String(args.layoutId ?? args.layout_id ?? "");
    const index = args.index != null ? Number(args.index) : null;
    const rawContent = args.content ?? "{}";
    const contentStr = typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent);
    return this._saveSlide({ content: contentStr, layoutId, index, replaceOldSlideAtIndex: false });
  }

  private async _updateSlide(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const layoutId = String(args.layoutId ?? args.layout_id ?? "");
    const index = Number(args.index ?? 0);
    const rawContent = args.content ?? "{}";
    const contentStr = typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent);
    return this._saveSlide({ content: contentStr, layoutId, index: index, replaceOldSlideAtIndex: true });
  }

  private async _getAvailableLayouts(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const layouts = await this._memory.getAvailableLayouts();
    return { count: layouts.length, layouts };
  }

  private async _getAvailableBlocks(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const maxResults = args.maxResults != null ? Number(args.maxResults) : 20;
    return this._memory.getAvailableBlocks({
      query: args.query as string ?? null,
      layoutId: args.layoutId as string ?? null,
      elementType: args.elementType as string ?? null,
      blockId: args.blockId as string ?? null,
      includeFullContent: Boolean(args.includeFullContent ?? false),
      maxResults,
    });
  }

  private async _getTemplateSummary(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [outline, layouts, theme] = await Promise.all([
      this._getPresentationOutline({}),
      this._getAvailableLayouts({}),
      this._getPresentationThemeCatalog({}),
    ]);
    return { outline, available_layouts: layouts, theme, message: "Template summary fetched successfully." };
  }

  private async _getSmartPresentationContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.getSmartPresentationContext({
      includeSlideHtml: Boolean(args.includeSlideHtml ?? false),
      maxHtmlCharsPerSlide: args.maxHtmlCharsPerSlide != null ? Number(args.maxHtmlCharsPerSlide) : undefined,
    });
  }

  private async _readSourceDocuments(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.readSourceDocuments({ query: args.query as string ?? null, maxChars: args.maxChars as number ?? null });
  }

  private async _getPresentationThemeCatalog(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.getPresentationThemeCatalog();
  }

  private async _getContentSchemaFromLayoutId(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const layoutId = String(args.layoutId ?? args.layout_id ?? "");
    const schema = await this._memory.getContentSchemaFromLayoutId(layoutId);
    if (schema == null) return { found: false, layout_id: layoutId, message: "Layout schema not found." };
    return { found: true, layout_id: layoutId, content_schema: schema };
  }

  private async _generateAssets(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const assets = Array.isArray(args.assets) ? args.assets as Array<Record<string, unknown>> : [];
    const generated: Array<Record<string, unknown>> = [];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const kind = String(asset.kind ?? "image");
      const prompt = String(asset.prompt ?? "");
      const url = kind === "icon"
        ? await this._memory.generateIcon(prompt)
        : await this._memory.generateImage(prompt);
      generated.push({ index: i, kind, prompt, url });
    }
    return { count: generated.length, assets: generated, message: `Generated ${generated.length} asset(s).` };
  }

  private async _saveSlide(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this._memory.presentationType === "smart") {
      return this._memory.saveSlide({
        content: {},
        layoutId: "",
        html: String(args.html ?? ""),
        index: Number(args.index ?? 0),
        replaceOldSlideAtIndex: Boolean(args.replaceOldSlideAtIndex ?? false),
      });
    }
    const rawContent = args.content ?? "{}";
    const contentStr = typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent);
    let contentParsed: Record<string, unknown>;
    try { contentParsed = loadsJsonish(contentStr) as Record<string, unknown>; }
    catch { contentParsed = JSON.parse(contentStr) as Record<string, unknown>; }
    if (typeof contentParsed !== "object" || contentParsed === null) throw new Error("'content' must be a JSON object.");
    const layoutId = String(args.layoutId ?? args.layout_id ?? "");
    const index = Number(args.index ?? 0);
    const replaceOldSlideAtIndex = Boolean(args.replaceOldSlideAtIndex ?? false);
    return this._memory.saveSlide({ content: contentParsed, layoutId, index, replaceOldSlideAtIndex });
  }

  private async _deleteSlide(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.deleteSlide(Number(args.index ?? 0));
  }

  private async _addElement(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const elementRaw = args.element ?? "{}";
    const elementStr = typeof elementRaw === "object" ? JSON.stringify(elementRaw) : String(elementRaw);
    let element: Record<string, unknown>;
    try { element = loadsJsonish(elementStr) as Record<string, unknown>; }
    catch { element = JSON.parse(elementStr) as Record<string, unknown>; }
    if (typeof element !== "object" || element === null) throw new Error("'element' must be a JSON object.");
    await this._requireReusableBlockFirst({ tree: element, sourceBlockId: null, primitiveTool: "addElement" });
    return this._memory.addSlideUiElement({
      index: Number(args.index ?? 0),
      element,
      componentId: args.componentId as string ?? null,
      insertIndex: args.insertIndex != null ? Number(args.insertIndex) : null,
    });
  }

  private async _updateSlideElement(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = Number(args.index ?? 0);
    const elementPath = String(args.elementPath ?? args.element_path ?? "");
    let elementPatch: Record<string, unknown> | null = null;
    if (args.element != null) {
      const raw = typeof args.element === "object" ? JSON.stringify(args.element) : String(args.element);
      try { elementPatch = loadsJsonish(raw) as Record<string, unknown>; }
      catch { elementPatch = JSON.parse(raw) as Record<string, unknown>; }
      if (typeof elementPatch !== "object" || elementPatch === null) throw new Error("'element' must be a JSON object.");
    }
    const stylePatch = elementStylePatchFromArgs(args);
    if (stylePatch && Object.keys(stylePatch).length > 0) {
      elementPatch = mergeDictPatch(elementPatch ?? {}, stylePatch);
    }
    return this._memory.updateSlideUiElement({
      index, elementPath, elementPatch,
      text: args.text != null ? String(args.text) : null,
      items: Array.isArray(args.items) ? args.items.map(String) : null,
      tableCell: args.tableCell as Record<string, unknown> ?? null,
      table: args.table as Record<string, unknown> ?? null,
      chart: args.chart as Record<string, unknown> ?? null,
      vector: args.vector as Record<string, unknown> ?? null,
      infographic: args.infographic as Record<string, unknown> ?? null,
      position: args.position as { x: number; y: number } ?? null,
      size: args.size as { width: number; height: number } ?? null,
    });
  }

  private async _updateSlideComponent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.updateSlideUiComponent({
      index: Number(args.index ?? 0),
      componentId: String(args.componentId ?? args.component_id ?? ""),
      position: args.position as { x: number; y: number } ?? null,
      size: args.size as { width: number; height: number } ?? null,
    });
  }

  private async _updateComponent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let replacementComponent: Record<string, unknown> | null = null;
    if (args.component != null) {
      const raw = typeof args.component === "object" ? JSON.stringify(args.component) : String(args.component);
      try { replacementComponent = loadsJsonish(raw) as Record<string, unknown>; }
      catch { replacementComponent = JSON.parse(raw) as Record<string, unknown>; }
      if (typeof replacementComponent !== "object" || replacementComponent === null) throw new Error("'component' must be a JSON object.");
    }
    return this._memory.updateSlideUiComponent({
      index: Number(args.index ?? 0),
      componentId: String(args.componentId ?? args.component_id ?? ""),
      action: args.action != null ? String(args.action) : null,
      componentIds: Array.isArray(args.componentIds) ? args.componentIds.map(String) : null,
      position: args.position as { x: number; y: number } ?? null,
      size: args.size as { width: number; height: number } ?? null,
      replacementComponent,
    });
  }

  private async _deleteSlideComponent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.deleteSlideUiComponent(Number(args.index ?? 0), String(args.componentId ?? args.component_id ?? ""));
  }

  private async _deleteSlideElement(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.deleteSlideUiElement(Number(args.index ?? 0), String(args.elementPath ?? args.element_path ?? ""));
  }

  private async _addSlideComponent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const compRaw = args.component ?? "{}";
    const compStr = typeof compRaw === "object" ? JSON.stringify(compRaw) : String(compRaw);
    let component: Record<string, unknown>;
    try { component = loadsJsonish(compStr) as Record<string, unknown>; }
    catch { component = JSON.parse(compStr) as Record<string, unknown>; }
    if (typeof component !== "object" || component === null) throw new Error("'component' must be a JSON object.");
    await this._requireReusableBlockFirst({
      tree: component,
      sourceBlockId: args.sourceBlockId as string ?? null,
      primitiveTool: "addComponent",
    });
    return this._memory.addSlideUiComponent({
      index: Number(args.index ?? 0),
      component,
      insertIndex: args.insertIndex != null ? Number(args.insertIndex) : null,
    });
  }

  private async _setPresentationTheme(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.setPresentationTheme({
      themeQuery: args.theme as string ?? null,
      customTheme: args.customTheme as Record<string, unknown> ?? null,
      saveCustomTheme: Boolean(args.saveCustomTheme ?? true),
    });
  }

  // ── Arg parsing and repair ─────────────────────────────────────────────────

  private _parseArgs(arguments_: string | null): Record<string, unknown> {
    if (!arguments_) return {};
    const parsed = loadsJsonish(arguments_);
    const normalized = normalizeArgValue(JSON.parse(JSON.stringify(parsed)));
    if (typeof normalized === "object" && normalized !== null) return normalized as Record<string, unknown>;
    throw new Error("Tool arguments must be a JSON object.");
  }

  private _repairToolArgs(toolName: string, args: Record<string, unknown>, error?: string): [Record<string, unknown>, string[]] {
    const repaired = { ...args };
    const notes: string[] = [];
    this._repairJsonObjectStringFields(toolName, repaired, notes);
    const afterChart = this._repairChartInsertArgs(toolName, repaired, notes);
    const afterTable = this._repairTableInsertArgs(toolName, afterChart, notes);
    const afterImage = this._repairImageInsertArgs(toolName, afterTable, notes);
    return [afterImage, notes];
  }

  private _repairJsonObjectStringFields(toolName: string, args: Record<string, unknown>, notes: string[]): void {
    for (const fieldName of JSON_OBJECT_STRING_FIELDS[toolName] ?? []) {
      if (!(fieldName in args)) continue;
      const value = args[fieldName];
      if (value == null) continue;
      if (typeof value === "object") {
        args[fieldName] = JSON.stringify(value);
        notes.push(`Converted ${fieldName} from object to JSON string.`);
        continue;
      }
      if (typeof value !== "string") continue;
      const parsed = loadsJsonishObject(value);
      if (parsed == null) continue;
      const canonical = JSON.stringify(parsed);
      if (canonical !== value) { args[fieldName] = canonical; notes.push(`Repaired JSON string field ${fieldName}.`); }
    }
  }

  private _repairChartInsertArgs(toolName: string, args: Record<string, unknown>, notes: string[]): Record<string, unknown> {
    const payloadField = CHART_INSERT_TOOL_FIELDS[toolName];
    if (!payloadField || !(payloadField in args)) return args;
    const chartRows = extractChartRowsFromUserMessage(this._turnUserMessage);
    if (!chartRows.length) return args;
    const payload = parseJsonObjectField(args[payloadField]);
    if (!payload) return args;
    const title = inferChartTitleFromUserMessage(this._turnUserMessage);
    if (!injectMissingChartData(payload, chartRows, title)) return args;
    const repaired = { ...args };
    repaired[payloadField] = JSON.stringify(payload);
    notes.push("Filled missing chart categories and series.values from the latest user message.");
    return repaired;
  }

  private _repairTableInsertArgs(toolName: string, args: Record<string, unknown>, notes: string[]): Record<string, unknown> {
    const payloadField = TABLE_INSERT_TOOL_FIELDS[toolName];
    if (!payloadField || !(payloadField in args)) return args;
    const tableData = extractTableFromUserMessage(this._turnUserMessage);
    if (!tableData) return args;
    const payload = parseJsonObjectField(args[payloadField]);
    if (!payload) return args;
    if (!injectMissingTableData(payload, tableData)) return args;
    const repaired = { ...args };
    repaired[payloadField] = JSON.stringify(payload);
    notes.push("Filled missing table headers/columns and rows from the latest user message.");
    return repaired;
  }

  private _repairImageInsertArgs(toolName: string, args: Record<string, unknown>, notes: string[]): Record<string, unknown> {
    const payloadField = IMAGE_INSERT_TOOL_FIELDS[toolName];
    if (!payloadField || !(payloadField in args)) return args;
    const payload = parseJsonObjectField(args[payloadField]);
    if (!payload) return args;
    if (!this._injectMissingImageData(payload)) return args;
    const repaired = { ...args };
    repaired[payloadField] = JSON.stringify(payload);
    notes.push("Filled missing image data from the generated asset URL in this turn.");
    return repaired;
  }

  private _rememberGeneratedAssets(result: Record<string, unknown>): void {
    const assets = Array.isArray(result.assets) ? result.assets : null;
    if (!assets) return;
    for (const asset of assets) {
      if (!asset || typeof asset !== "object") continue;
      const a = asset as Record<string, unknown>;
      const url = String(a.url ?? "").trim();
      if (!url) continue;
      this._generatedAssets.push({ kind: String(a.kind ?? "image"), prompt: String(a.prompt ?? ""), url });
    }
  }

  private _injectMissingImageData(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    let changed = false;
    if (Array.isArray(node)) {
      for (const item of node) changed = this._injectMissingImageData(item) || changed;
      return changed;
    }
    const n = node as Record<string, unknown>;
    if (n.type === "image" && !imageElementHasExplicitData(n)) {
      const asset = this._latestGeneratedAssetForImage(n.is_icon === true);
      if (asset) {
        n.data = asset.url;
        if (!("is_icon" in n)) n.is_icon = asset.kind === "icon";
        if (asset.prompt && !("prompt" in n)) n.prompt = asset.prompt;
        changed = true;
      }
    }
    for (const value of Object.values(n)) changed = this._injectMissingImageData(value) || changed;
    return changed;
  }

  private _latestGeneratedAssetForImage(isIcon: boolean): { kind: string; prompt: string; url: string } | null {
    const preferred = isIcon ? "icon" : "image";
    for (let i = this._generatedAssets.length - 1; i >= 0; i--) {
      if (this._generatedAssets[i].kind === preferred) return this._generatedAssets[i];
    }
    for (let i = this._generatedAssets.length - 1; i >= 0; i--) {
      if (this._generatedAssets[i].url) return this._generatedAssets[i];
    }
    return null;
  }

  private async _requireReusableBlockFirst(opts: { tree: Record<string, unknown>; sourceBlockId: string | null; primitiveTool: string }): Promise<void> {
    const requestedTypes = blockPrioritizedElementTypes(opts.tree);
    if (!requestedTypes.size) return;
    if (opts.sourceBlockId) {
      const blockResult = await this._memory.getAvailableBlocks({ blockId: opts.sourceBlockId, includeFullContent: false, maxResults: 1 });
      const blocks = Array.isArray(blockResult.blocks) ? blockResult.blocks as unknown[] : null;
      const block = blocks?.[0];
      if (!block || typeof block !== "object") throw new Error("sourceBlockId was provided but no matching reusable block was found. Call getAvailableBlocks again and use a returned block_id.");
      const blockTypes = new Set(((block as Record<string, unknown>).element_types as string[] ?? []).map((t) => t.toLowerCase()));
      if ([...requestedTypes].every((t) => !blockTypes.has(t))) {
        throw new Error("sourceBlockId does not match the table/chart type being inserted. Use a block_id whose element_types include the requested type.");
      }
      return;
    }
    const reusable = await this._firstAvailableReusableBlock(requestedTypes);
    if (!reusable) return;
    const [elementType, block] = reusable;
    const b = block as Record<string, unknown>;
    throw new Error(`Reusable block available for ${elementType} insertion (block_id='${b.block_id}', component_id='${b.component_id}', layout_id='${b.layout_id}'). Do not use ${opts.primitiveTool} to create this as a primitive. Call getAvailableBlocks with that blockId and includeFullContent=true, adapt the returned component JSON with the requested content, then call addComponent/createComponent with sourceBlockId='${b.block_id}'.`);
  }

  private async _firstAvailableReusableBlock(requestedTypes: Set<string>): Promise<[string, unknown] | null> {
    for (const elementType of [...requestedTypes].sort()) {
      const blockResult = await this._memory.getAvailableBlocks({ elementType, includeFullContent: false, maxResults: 1 });
      const blocks = Array.isArray(blockResult.blocks) ? blockResult.blocks as unknown[] : null;
      const block = blocks?.[0];
      if (block && typeof block === "object") return [elementType, block];
    }
    return null;
  }

  private _buildToolRecovery(opts: { toolName: string; args: Record<string, unknown> | null; error: string }): Record<string, unknown> {
    const { toolName, args, error } = opts;
    const normalizedError = error.toLowerCase();
    const guidance: string[] = [];
    const expected: Record<string, unknown> = {};
    let retryable = true;

    if (!CHART_INSERT_TOOL_FIELDS[toolName] && !JSON_OBJECT_STRING_FIELDS[toolName]) {
      guidance.push("Review the tool schema and retry with corrected arguments.");
    }
    if (normalizedError.includes("reusable block available")) {
      guidance.push("Use getAvailableBlocks with includeFullContent=true for the returned block_id, adapt that component JSON, then retry with addComponent/createComponent and sourceBlockId.");
      expected.block_workflow = { discovery: { tool: "getAvailableBlocks", arguments: { blockId: "returned block_id", includeFullContent: true } }, insert: { tool: "addComponent", arguments: { component: "JSON string adapted from returned block.component", sourceBlockId: "returned block_id" } } };
    }
    const jsonFields = JSON_OBJECT_STRING_FIELDS[toolName] ?? [];
    if (jsonFields.length) {
      guidance.push(`Ensure ${jsonFields.join(", ")} is a JSON-serialized object string, not prose.`);
      expected.json_object_string_fields = jsonFields;
    }
    if (normalizedError.includes("chart elements must include numeric data")) {
      guidance.push("For chart elements include categories and series with numeric values before retrying.");
      expected.chart = { type: "chart", chart_type: "bar", categories: ["Label A", "Label B"], series: [{ name: "Series name", values: [1, 2] }] };
    }
    if (normalizedError.includes("table elements must include")) {
      guidance.push("For table elements include columns or headers plus rows before retrying.");
      expected.table = { type: "table", columns: ["Name", "Age", "Department"], rows: [["Ghanshyam", "30", "QA"], ["Sudeep", "33", "AI"]] };
    }
    if (normalizedError.includes("image elements must include")) {
      guidance.push("For image elements call generateAssets first, then include the returned URL as data before retrying.");
      expected.image = { type: "image", data: "/app_data/images/generated.png", is_icon: false };
    }
    if (normalizedError.includes("validation error")) {
      guidance.push("Use the field names and aliases from the tool schema, include required nullable fields as null, and remove unsupported keys.");
    }
    if (normalizedError.includes("json") || normalizedError.includes("expecting value")) {
      guidance.push("Return valid JSON only for tool arguments; avoid Markdown fences in tool-call arguments.");
    }
    if (normalizedError.includes("no slide found") || normalizedError.includes("was not found")) {
      guidance.push("Inspect the deck with getSlideAtIndex or searchSlide and retry with the returned slide index, componentId, or elementPath.");
    }
    if (normalizedError.includes("unsupported tool")) {
      retryable = false;
      guidance.length = 0;
      guidance.push("Choose one of the available tool names from the current tool definitions.");
    }
    if (!guidance.length) guidance.push("Fix the arguments based on the error and retry once.");

    const recovery: Record<string, unknown> = {
      retryable, message: retryable ? "Repair the tool arguments before retrying." : "Do not retry this exact tool call.", guidance,
    };
    if (Object.keys(expected).length) recovery.expected = expected;
    if (args != null) recovery.received_keys = Object.keys(args).sort();
    return recovery;
  }
}

// ── Static helpers ─────────────────────────────────────────────────────────

function extractTitle(content: string): string {
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const m = /^#{1,6}\s*(.+?)\s*$/.exec(s);
    if (m) return m[1].trim();
    return s.substring(0, 120);
  }
  return "";
}

function argsEquivalent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left, Object.keys(left).sort()) === JSON.stringify(right, Object.keys(right).sort());
}

function mergeDictPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === "object" && typeof merged[key] === "object" && merged[key] !== null && !Array.isArray(value)) {
      merged[key] = mergeDictPatch(merged[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = JSON.parse(JSON.stringify(value));
    }
  }
  return merged;
}

function elementStylePatchFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (args.font != null) patch.font = args.font;
  if (args.alignment != null) patch.alignment = args.alignment;
  if (args.fill != null) patch.fill = args.fill;
  if (args.stroke != null) patch.stroke = args.stroke;
  if (args.color != null) patch.color = args.color;
  if (args.opacity != null) patch.opacity = args.opacity;
  return patch;
}

function loadsJsonishObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = loadsJsonish(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function parseJsonObjectField(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  return loadsJsonishObject(value);
}

function blockPrioritizedElementTypes(tree: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const item of v) visit(item); return; }
    const node = v as Record<string, unknown>;
    const et = typeof node.type === "string" ? node.type.trim().toLowerCase() : null;
    if (et && BLOCK_PRIORITIZED_INSERT_TYPES.has(et)) found.add(et);
    for (const val of Object.values(node)) visit(val);
  };
  visit(tree);
  return found;
}

function imageElementHasExplicitData(element: Record<string, unknown>): boolean {
  const data = element.data;
  return typeof data === "string" && data.trim().length > 0;
}

function chartElementHasExplicitData(element: Record<string, unknown>): boolean {
  const categories = element.categories;
  const series = element.series;
  const data = element.data;
  return (Array.isArray(categories) && categories.length > 0 && Array.isArray(series) && series.length > 0) ||
    (Array.isArray(data) && data.length > 0);
}

function tableElementHasExplicitData(element: Record<string, unknown>): boolean {
  const columns = element.columns;
  const rows = element.rows;
  return Array.isArray(columns) && columns.length > 0 && Array.isArray(rows) && rows.length > 0;
}

function injectMissingChartData(node: unknown, rows: Array<{ label: string; value: number }>, title: string): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) { for (const item of node) changed = injectMissingChartData(item, rows, title) || changed; return changed; }
  const n = node as Record<string, unknown>;
  if (n.type === "chart" && !chartElementHasExplicitData(n)) {
    n.chart_type ??= "bar";
    n.title ??= title;
    n.categories = rows.map((r) => r.label);
    n.series = [{ name: title || "Series 1", values: rows.map((r) => r.value) }];
    n.data = rows.map((r) => ({ label: r.label, value: r.value }));
    changed = true;
  }
  for (const value of Object.values(n)) changed = injectMissingChartData(value, rows, title) || changed;
  return changed;
}

function injectMissingTableData(node: unknown, tableData: { columns: string[]; rows: string[][] }): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) { for (const item of node) changed = injectMissingTableData(item, tableData) || changed; return changed; }
  const n = node as Record<string, unknown>;
  if (n.type === "table" && !tableElementHasExplicitData(n)) {
    n.columns = tableData.columns;
    n.rows = tableData.rows;
    n.min_columns ??= 1;
    n.max_columns ??= Math.max(tableData.columns.length, 1);
    n.min_rows ??= 1;
    n.max_rows ??= Math.max(tableData.rows.length, 1);
    changed = true;
  }
  for (const value of Object.values(n)) changed = injectMissingTableData(value, tableData) || changed;
  return changed;
}

function extractChartRowsFromUserMessage(userMessage: string): Array<{ label: string; value: number }> {
  const text = stripUiContextPrefix(userMessage);
  if (!text) return [];
  const rows: Array<{ label: string; value: number }> = [];
  const seen = new Set<string>();
  const segments = text.split(/[\n;,|]+|\s+\band\b\s+/i);
  for (const segment of segments) {
    const seg = segment.trim().replace(/^[-–—:.]*\s*/, "");
    if (!seg) continue;
    const re = /(?<label>[A-Za-z][A-Za-z0-9&'./() -]{0,80}?)\s*(?:[:=\-–—]|\bhas\b|\bhave\b|\bwith\b)?\s+(?<value>[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\b/g;
    for (const m of seg.matchAll(re)) {
      const label = cleanChartLabel(m.groups!.label);
      if (!label) continue;
      const value = parseChartNumber(m.groups!.value);
      if (value == null) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ label, value });
      if (rows.length >= 12) return rows;
    }
  }
  return rows.length >= 2 ? rows : [];
}

function extractTableFromUserMessage(userMessage: string): { columns: string[]; rows: string[][] } | null {
  const text = stripUiContextPrefix(userMessage);
  if (!text) return null;
  const markerMatch = /\bdata\s*:\s*(?<data>.+)$/is.exec(text);
  if (markerMatch) {
    const headerText = text.slice(0, markerMatch.index);
    const headers = extractTableHeaders(headerText);
    const rows = parseTableRows(markerMatch.groups!.data);
    if (headers.length && rows.length) {
      const aligned = alignTableRows(rows, headers.length);
      if (aligned.length) return { columns: headers, rows: aligned };
    }
  }
  const csvRows = parseTableRows(text, /[\n;]+/);
  if (csvRows.length >= 2) {
    const headers = csvRows[0];
    const rows = alignTableRows(csvRows.slice(1), headers.length);
    if (headers.length && rows.length) return { columns: headers, rows };
  }
  return null;
}

function extractTableHeaders(text: string): string[] {
  const patterns = [
    /\bfirst\s+row\s+with\s+(?<headers>[^.\n;]+)/i,
    /\bheaders?\s*(?:are|with|:)?\s+(?<headers>[^.\n;]+)/i,
    /\bcolumns?\s*(?:are|with|:)?\s+(?<headers>[^.\n;]+)/i,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) {
      const headers = splitTableCells(m.groups!.headers);
      if (headers.length >= 1) return headers;
    }
  }
  return [];
}

function parseTableRows(text: string, splitPattern: RegExp = /[;\n]+/): string[][] {
  return text.split(splitPattern).map(splitTableCells).filter((r) => r.length > 0);
}

function splitTableCells(text: string): string[] {
  return text.split(/\s*\|\s*|\s*,\s*/).map((c) => c.trim().replace(/^[-–—:.]*\s*/, "").replace(/\s*[-–—:.]*$/, "")).filter(Boolean);
}

function alignTableRows(rows: string[][], colCount: number): string[][] {
  return rows.filter((r) => r.length === colCount);
}

function cleanChartLabel(value: string): string {
  let label = value.replace(/\s+/g, " ").trim().replace(/^[-–—:.]*\s*/, "").replace(/\s*[-–—:.]*$/, "");
  label = label.replace(/^(?:and|the|for|category|label|value|metric|series)\s+/i, "").trim().replace(/^[-–—:.]*\s*/, "");
  if (!label) return "";
  if (["slide", "index", "chart", "bar chart", "line chart", "user message"].includes(label.toLowerCase())) return "";
  return label === label.toLowerCase() ? label[0].toUpperCase() + label.slice(1) : label;
}

function parseChartNumber(value: string): number | null {
  const n = parseFloat(value.replace(/,/g, ""));
  if (!isFinite(n)) return null;
  return Number.isInteger(n) ? n : n;
}

function inferChartTitleFromUserMessage(userMessage: string): string {
  const text = stripUiContextPrefix(userMessage);
  const quotedTitle = /\b(?:titled|called|named)\s+["']([^"']{1,80})["']/i.exec(text);
  if (quotedTitle) return quotedTitle[1].trim();
  const countTitle = /\b(?:number\s+of|no\.?\s*of|no\s+of)\s+(?<title>[A-Za-z][A-Za-z ]{1,40}?)(?:\s+(?:the|for|by|of|that|which)\b|[.,;\n]|$)/i.exec(text);
  if (countTitle) { const t = countTitle.groups!.title.trim(); if (t) return t[0].toUpperCase() + t.slice(1); }
  const lower = text.toLowerCase();
  for (const [kw, title] of [["goal", "Goals"], ["revenue", "Revenue"], ["sales", "Sales"], ["profit", "Profit"], ["age", "Age"]] as [string, string][]) {
    if (lower.includes(kw)) return title;
  }
  return "Chart";
}

function stripUiContextPrefix(userMessage: string): string {
  const marker = "\nUser message:";
  if (!userMessage.startsWith("UI context:")) return userMessage.trim();
  const idx = userMessage.indexOf(marker);
  if (idx === -1) return userMessage.trim();
  return userMessage.slice(idx + marker.length).trimStart();
}
