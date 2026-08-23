/**
 * Phase 1 smoke tests — verifies the scaffolded presenting engine module
 * typechecks, core utilities work, template schema parsing is sound, and
 * template-binding hydration works against a real template.json. No model
 * calls — those require a live sidecar + credentials.
 */
import { describe, it, expect } from "vitest";
import { loadsJsonish } from "../utils/jsonish.js";
import { normalizeOutlineContent, normalizeOutlinePayload, MAX_OUTLINE_CONTENT_WORDS } from "../utils/outline-limits.js";
import { extractIconTypeFromSettings, DEFAULT_ICON_TYPE } from "../utils/icon-weights.js";
import { parseLatexTags, normalizeLatex, replaceTextRuns } from "../utils/latex-text.js";
import { removeFieldsFromSchema, addFieldInSchema, ensureArraySchemasHaveItems } from "../utils/schema-utils.js";
import { getTemplateSchema, getRepeatedTopLevelGroupSchemaName } from "../services/template-schema.js";
import { isTemplateLayoutPayload, buildTemplateLayoutModel, hydrateTemplateSlideUi, applyTemplateContentToUi } from "../services/template-binding.js";
import { listTemplateNames, getTemplate } from "../services/template-store.js";
import { getOutlineSystemPrompt, getOutlineUserPrompt } from "../services/outline-generation.js";
import { getSlideSystemPrompt, getSlideUserPrompt } from "../services/slide-content-generation.js";
import { getPresentationTitleFromOutline } from "../utils/outline-utils.js";
import { initDb, getDb, closeDb } from "../db/index.js";
import { saveGeneratedPresentation } from "../db/presentation-store.js";

// ─── jsonish ────────────────────────────────────────────────────────────────

describe("loadsJsonish", () => {
  it("parses plain JSON", () => {
    expect(loadsJsonish('{"slides":[{"content":"hello"}]}')).toEqual({ slides: [{ content: "hello" }] });
  });

  it("strips markdown fences", () => {
    const input = '```json\n{"a":1}\n```';
    expect(loadsJsonish(input)).toEqual({ a: 1 });
  });

  it("extracts JSON from surrounding prose", () => {
    expect(loadsJsonish('Here is the result: {"x":42}. Hope that helps!')).toEqual({ x: 42 });
  });

  it("throws on empty string", () => {
    expect(() => loadsJsonish("")).toThrow();
  });
});

// ─── outline limits ─────────────────────────────────────────────────────────

describe("normalizeOutlineContent", () => {
  it("trims to 100 words", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const result = normalizeOutlineContent(words);
    const count = result.split(/\S+/g).filter(Boolean).length;
    // normalizeOutlineContent trims to max MAX_OUTLINE_CONTENT_WORDS
    expect(result.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(MAX_OUTLINE_CONTENT_WORDS);
  });

  it("passes through short strings unchanged", () => {
    expect(normalizeOutlineContent("hello world")).toBe("hello world");
  });

  it("converts non-strings", () => {
    expect(normalizeOutlineContent(42)).toBe("42");
    expect(normalizeOutlineContent(null)).toBe("");
  });
});

describe("normalizeOutlinePayload", () => {
  it("caps slide count", () => {
    const payload = { slides: Array.from({ length: 60 }, (_, i) => ({ content: `slide ${i}` })) };
    const result = normalizeOutlinePayload(payload, 50);
    expect((result.slides as any[]).length).toBe(50);
  });
});

// ─── icon weights ───────────────────────────────────────────────────────────

describe("extractIconTypeFromSettings", () => {
  it("returns default for null", () => {
    expect(extractIconTypeFromSettings(null)).toBe(DEFAULT_ICON_TYPE);
  });
  it("extracts icon_type", () => {
    expect(extractIconTypeFromSettings({ icon_type: "light" })).toBe("light");
  });
  it("normalises invalid values", () => {
    expect(extractIconTypeFromSettings({ icon_type: "invalid_value" })).toBe(DEFAULT_ICON_TYPE);
  });
  it("recurses into settings", () => {
    expect(extractIconTypeFromSettings({ settings: { icon_type: "fill" } })).toBe("fill");
  });
});

// ─── latex text ─────────────────────────────────────────────────────────────

describe("parseLatexTags", () => {
  it("returns null for plain text", () => {
    expect(parseLatexTags("hello world")).toBeNull();
  });
  it("parses single latex tag", () => {
    const runs = parseLatexTags("area <latex>\\pi r^2</latex>");
    expect(runs).not.toBeNull();
    expect(runs).toHaveLength(2);
    expect(runs![0]).toEqual({ text: "area " });
    expect(runs![1]).toMatchObject({ type: "latex" });
  });
  it("returns null for unclosed tag", () => {
    expect(parseLatexTags("<latex>x")).toBeNull();
  });
});

describe("replaceTextRuns", () => {
  it("creates a single text run for plain text", () => {
    const runs = replaceTextRuns([], "hello");
    expect(runs).toHaveLength(1);
    expect((runs[0] as any).text).toBe("hello");
  });
});

// ─── schema utils ───────────────────────────────────────────────────────────

describe("removeFieldsFromSchema", () => {
  it("removes specified fields from properties", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const result = removeFieldsFromSchema(schema, ["b"]);
    expect((result.properties as any).a).toBeDefined();
    expect((result.properties as any).b).toBeUndefined();
    expect(result.required).toEqual(["a"]);
  });
});

describe("ensureArraySchemasHaveItems", () => {
  it("adds items to array schemas without them", () => {
    const schema = { type: "object", properties: { list: { type: "array" } } };
    const result = ensureArraySchemasHaveItems(schema);
    expect(((result.properties as any).list as any).items).toEqual({ type: "string" });
  });
});

// ─── template schema ────────────────────────────────────────────────────────

describe("getTemplateSchema", () => {
  it("throws for template without layouts array", () => {
    expect(() => getTemplateSchema({})).toThrow("layouts array");
  });

  it("processes a minimal template.json", () => {
    const templateJson = {
      layouts: [
        {
          id: "title",
          description: "Title layout",
          components: [
            {
              id: "headline",
              elements: [
                { type: "text", name: "title", decorative: false, min_length: 1, max_length: 100 },
              ],
            },
          ],
        },
      ],
    };
    const schema = getTemplateSchema(templateJson);
    expect(schema.layout_count).toBe(1);
    expect((schema.layouts as any[])[0].layout_id).toBe("title");
    expect((schema.layouts as any[])[0].schema).not.toBeNull();
  });
});

describe("getRepeatedTopLevelGroupSchemaName", () => {
  it("returns null for non-group elements", () => {
    expect(getRepeatedTopLevelGroupSchemaName([{ type: "text", name: "t", decorative: false }])).toBeNull();
  });
});

// ─── template binding ───────────────────────────────────────────────────────

describe("isTemplateLayoutPayload", () => {
  it("returns true for valid payload", () => {
    expect(isTemplateLayoutPayload({ layouts: [] })).toBe(true);
  });
  it("returns false for non-object", () => {
    expect(isTemplateLayoutPayload("string")).toBe(false);
    expect(isTemplateLayoutPayload(null)).toBe(false);
  });
});

describe("applyTemplateContentToUi", () => {
  it("returns ui unchanged when no components", () => {
    const ui = { id: "slide", components: [] };
    expect(applyTemplateContentToUi(ui, {})).toEqual(ui);
  });

  it("applies text content to a text element", () => {
    const ui = {
      id: "slide",
      components: [
        {
          id: "header",
          elements: [
            { type: "text", name: "title", decorative: false, runs: [{ text: "old", font: { size: 24 } }] },
          ],
        },
      ],
    };
    const content = { header: { title: "New Heading" } };
    const result = applyTemplateContentToUi(ui, content);
    const runs = (result!.components as any[])[0].elements[0].runs;
    expect(runs[0].text).toBe("New Heading");
  });
});

// ─── template store ─────────────────────────────────────────────────────────

describe("template-store", () => {
  it("lists known template names", () => {
    const names = listTemplateNames();
    // The test environment may not have the backend checkout at the expected path.
    // Accept either "populated" (full dev checkout) or "empty" (CI/isolated).
    expect(Array.isArray(names)).toBe(true);
  });

  it("returns null for unknown template", () => {
    expect(getTemplate("nonexistent_template_xyz")).toBeNull();
  });

  it("returns template data when templates exist", () => {
    const names = listTemplateNames();
    if (names.length > 0) {
      const data = getTemplate(names[0]);
      expect(data).not.toBeNull();
      expect(typeof data).toBe("object");
      expect(Array.isArray((data as any).layouts)).toBe(true);
    }
  });
});

// ─── buildTemplateLayoutModel (integration with real template) ───────────────

describe("buildTemplateLayoutModel - real template", () => {
  it("builds a layout model from the first available template", () => {
    const names = listTemplateNames();
    if (names.length === 0) return; // skip in CI without backend checkout
    const templateData = getTemplate(names[0])!;
    const layoutPayload = { ...templateData, name: names[0], template_id: names[0] };
    const model = buildTemplateLayoutModel(layoutPayload, { layout_name: names[0] });
    expect(model.name).toBe(names[0]);
    expect(Array.isArray(model.slides)).toBe(true);
    expect(model.slides.length).toBeGreaterThan(0);
  });
});

// ─── outline generation prompts ─────────────────────────────────────────────

describe("outline prompt builders", () => {
  it("system prompt contains key instructions", () => {
    const p = getOutlineSystemPrompt();
    expect(p).toContain("Generate presentation title and content for slides");
    expect(p).toContain("JSON object");
  });

  it("user prompt contains content", () => {
    const p = getOutlineUserPrompt("AI trends", 5, "English");
    expect(p).toContain("AI trends");
    expect(p).toContain("Number of Slides: 5");
    expect(p).toContain("Language: English");
  });

  it("user prompt uses auto-detect when language is null", () => {
    const p = getOutlineUserPrompt("test", null, null);
    expect(p).toContain("auto-detect");
  });
});

// ─── slide content prompts ───────────────────────────────────────────────────

describe("slide content prompt builders", () => {
  it("system prompt includes output fields instruction", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    const p = getSlideSystemPrompt(null, null, null, schema as any);
    expect(p).toContain("title");
  });

  it("user prompt includes slide content", () => {
    const p = getSlideUserPrompt("## Introduction\nAI is transforming industries", "English", 1);
    expect(p).toContain("Introduction");
    expect(p).toContain("Slide Number");
  });
});

// ─── outline utils ───────────────────────────────────────────────────────────

describe("getPresentationTitleFromOutline", () => {
  it("returns Untitled Presentation for empty outline", () => {
    expect(getPresentationTitleFromOutline({ slides: [] })).toBe("Untitled Presentation");
  });

  it("extracts title from first slide heading", () => {
    const outline = { slides: [{ content: "## The Future of AI\nSome content here" }, { content: "## Slide 2" }] };
    const title = getPresentationTitleFromOutline(outline);
    expect(title).toContain("Future");
  });

  it("strips Page N prefix", () => {
    const outline = { slides: [{ content: "## Page 1: Introduction" }] };
    const title = getPresentationTitleFromOutline(outline);
    expect(title).not.toContain("Page 1");
    expect(title).toContain("Introduction");
  });
});

// ─── db layer ───────────────────────────────────────────────────────────────

describe("DB layer", () => {
  it("initialises and accepts queries", () => {
    initDb();
    const db = getDb();
    const row = db.prepare("SELECT 1+1 as val").get() as any;
    expect(row.val).toBe(2);
    closeDb();
  });

  it("can save and load a generated presentation", () => {
    initDb();
    const fakeTemplate = {
      layouts: [{ id: "title", components: [] }],
    };
    const getTemplateFn = (_name: string) => fakeTemplate;

    const generated = {
      title: "Test Presentation",
      template: "general",
      language: "English",
      slides: [
        {
          layout: "title",
          content: { headline: "Hello world", __speaker_note__: "Speaker notes here" },
          ui: { id: "title", components: [] },
        },
      ],
    };

    const id = saveGeneratedPresentation(generated as any, getTemplateFn as any);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const db = getDb();
    const row = db.prepare("SELECT * FROM presentations WHERE id = ?").get(id) as any;
    expect(row).not.toBeNull();
    expect(row.title).toBe("Test Presentation");

    const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ?").all(id) as any[];
    expect(slides.length).toBe(1);
    // speaker_note should be extracted from content
    expect(slides[0].speaker_note).toBe("Speaker notes here");
    const savedContent = JSON.parse(slides[0].content);
    expect(savedContent.__speaker_note__).toBeUndefined();

    closeDb();
  });
});
