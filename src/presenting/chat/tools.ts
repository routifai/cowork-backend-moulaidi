/**
 * ChatTools — LLM tool registry + executor for Smart presentation editing.
 * Smart-only: slides are whole-HTML replacements, no structural element
 * tree, so there's no element/component-level tool surface.
 */

import { loadsJsonish } from "../utils/jsonish.js";
import type { PresentationContextStore } from "../db/presentation-context.js";
import type { Tool, ToolCall } from "./llm-tool-types.js";

export type ChatToolMode = "presentation" | "outline";

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const MAX_TOOL_REPAIR_RETRIES = 1;

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
  private readonly _toolHandlers: Record<string, ToolHandler>;

  constructor(memory: PresentationContextStore, mode: ChatToolMode = "presentation") {
    this._memory = memory;
    this._mode = mode;
    this._toolHandlers = {
      getSmartPresentationContext: this._getSmartPresentationContext.bind(this),
      readSourceDocuments: this._readSourceDocuments.bind(this),
      searchSlide: this._searchSlides.bind(this),
      getSlideAtIndex: this._getSlideAtIndex.bind(this),
      generateAssets: this._generateAssets.bind(this),
      saveSlide: this._saveSlide.bind(this),
      deleteSlide: this._deleteSlide.bind(this),
    };
  }

  setTurnContext(userMessage: string): void {
    this._turnUserMessage = userMessage ?? "";
  }

  getToolDefinitions(): Tool[] {
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
    try {
      parsedArgs = this._parseArgs(toolCall.arguments ?? null);
      const result = await handler(parsedArgs);
      return { ok: true, tool: toolCall.name, result };
    } catch (exc) {
      return {
        ok: false, tool: toolCall.name, error: String(exc),
        recovery: this._buildToolRecovery({ toolName: toolCall.name, args: parsedArgs, error: String(exc) }),
      };
    }
  }

  // ── Tool Handlers ─────────────────────────────────────────────────────────

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

  private async _getSmartPresentationContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.getSmartPresentationContext({
      includeSlideHtml: Boolean(args.includeSlideHtml ?? false),
      maxHtmlCharsPerSlide: args.maxHtmlCharsPerSlide != null ? Number(args.maxHtmlCharsPerSlide) : undefined,
    });
  }

  private async _readSourceDocuments(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.readSourceDocuments({ query: args.query as string ?? null, maxChars: args.maxChars as number ?? null });
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
    return this._memory.saveSlide({
      html: String(args.html ?? ""),
      index: Number(args.index ?? 0),
      replaceOldSlideAtIndex: Boolean(args.replaceOldSlideAtIndex ?? false),
    });
  }

  private async _deleteSlide(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._memory.deleteSlide(Number(args.index ?? 0));
  }

  // ── Arg parsing and repair ─────────────────────────────────────────────────

  private _parseArgs(arguments_: string | null): Record<string, unknown> {
    if (!arguments_) return {};
    const parsed = loadsJsonish(arguments_);
    const normalized = normalizeArgValue(JSON.parse(JSON.stringify(parsed)));
    if (typeof normalized === "object" && normalized !== null) return normalized as Record<string, unknown>;
    throw new Error("Tool arguments must be a JSON object.");
  }

  private _buildToolRecovery(opts: { toolName: string; args: Record<string, unknown> | null; error: string }): Record<string, unknown> {
    const { toolName, args, error } = opts;
    const normalizedError = error.toLowerCase();
    const guidance: string[] = [];
    let retryable = true;

    guidance.push("Review the tool schema and retry with corrected arguments.");
    if (normalizedError.includes("json") || normalizedError.includes("expecting value")) {
      guidance.push("Return valid JSON only for tool arguments; avoid Markdown fences in tool-call arguments.");
    }
    if (normalizedError.includes("no slide found") || normalizedError.includes("was not found")) {
      guidance.push("Inspect the deck with getSlideAtIndex or searchSlide and retry with the returned slide index.");
    }
    if (normalizedError.includes("unsupported tool")) {
      retryable = false;
      guidance.length = 0;
      guidance.push("Choose one of the available tool names from the current tool definitions.");
    }

    const recovery: Record<string, unknown> = {
      retryable, message: retryable ? "Repair the tool arguments before retrying." : "Do not retry this exact tool call.", guidance,
    };
    if (args != null) recovery.received_keys = Object.keys(args).sort();
    return recovery;
  }
}
