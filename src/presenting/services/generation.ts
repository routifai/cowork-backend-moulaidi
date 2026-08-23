/**
 * Presentation generation orchestrator.
 * Port of presenting/engine/services/generation.py with Phase 2 parity additions:
 * - Proper TOC two-phase insertion (fewer outlines + structural insertion after layout selection)
 * - Web search grounding via external providers
 */
import { resolveTemplateData } from "./template-resolver.js";
import { buildTemplateLayoutModel, hydrateTemplateSlideUi } from "./template-binding.js";
import { generatePptOutline } from "./outline-generation.js";
import { generatePresentationStructure } from "./structure-generation.js";
import { getSlideContentFromTypeAndOutline } from "./slide-content-generation.js";
import { buildWebSearchAdditionalContext, type WebSearchProvider } from "./web-search.js";
import { processSlideAndFetchAssets } from "./process-slides.js";
import {
  getPresentationTitleFromOutline,
  getNoOfOutlinesToGenerateForNSlides,
  getNoOfTocRequiredForNOutlines,
  getPresentationOutlineModelWithToc,
  insertTocLayouts,
} from "../utils/outline-utils.js";
import { layoutToStructure } from "../utils/models.js";
import type { PresentationLayoutModel, PresentationStructureModel } from "../utils/models.js";

export class TemplateNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TemplateNotFoundError";
  }
}

export interface GeneratedSlide {
  layout: string;
  content: Record<string, unknown>;
  ui: unknown;
}

export interface GeneratedPresentation {
  title: string;
  template: string;
  language?: string;
  slides: GeneratedSlide[];
}

function clampStructureToOutline(structure: number[], outlineLength: number, layoutCount: number): number[] {
  return structure.map((idx) => Math.max(0, Math.min(idx, layoutCount - 1))).slice(0, outlineLength);
}

/** Find the 0-based index of the Table of Contents layout in a layout model, or -1. */
function findTocLayoutIndex(layoutModel: PresentationLayoutModel): number {
  for (const [index, slide] of layoutModel.slides.entries()) {
    const name = (slide.name ?? "").toLowerCase();
    const desc = (slide.description ?? "").toLowerCase();
    const id = (slide.id ?? "").toLowerCase();
    if (name.includes("table of contents") || desc.includes("table of contents") || id.includes("toc")) {
      return index;
    }
  }
  return -1;
}

export async function generatePresentation(
  deps: { modelRuntime: any; modelRegistry: any; hypatiaDir: string; workspaceCwd: string },
  opts: {
    content: string;
    template: string;
    provider: string;
    model: string;
    n_slides?: number | null;
    language?: string | null;
    tone?: string | null;
    verbosity?: string | null;
    instructions?: string | null;
    include_title_slide?: boolean;
    include_table_of_contents?: boolean;
    web_search?: boolean;
    web_search_provider?: WebSearchProvider;
  },
): Promise<GeneratedPresentation> {
  const templateData = resolveTemplateData(opts.template, deps);
  if (!templateData) throw new TemplateNotFoundError(`Template '${opts.template}' not found`);

  const layoutPayload: Record<string, unknown> = { ...templateData, name: opts.template, template_id: opts.template };
  const layoutModel = buildTemplateLayoutModel(layoutPayload, { layout_name: opts.template });

  const includeTitleSlide = opts.include_title_slide ?? true;
  const includeToc = opts.include_table_of_contents ?? false;

  // ── Web search: build additional context before outline generation ─────────
  let additionalContext: string | undefined;
  if (opts.web_search) {
    try {
      const ctx = await buildWebSearchAdditionalContext(
        deps,
        opts.content,
        opts.provider,
        opts.model,
        opts.web_search_provider ?? "auto",
        opts.instructions,
      );
      if (ctx) additionalContext = ctx;
    } catch {
      // web search failure is non-fatal; proceed without context
    }
  }

  // ── TOC parity: adjust n_slides for outline generation ────────────────────
  // When TOC is enabled and n_slides is set, we generate fewer content outlines
  // and insert TOC outline placeholders after, matching Presenton's prepare flow.
  let nSlidesForOutline = opts.n_slides;
  if (includeToc && opts.n_slides != null) {
    nSlidesForOutline = getNoOfOutlinesToGenerateForNSlides({
      n_slides: opts.n_slides,
      toc: true,
      title_slide: includeTitleSlide,
    });
  }

  // ── Generate outline ───────────────────────────────────────────────────────
  const outline = await generatePptOutline(
    deps,
    opts.content,
    nSlidesForOutline,
    opts.provider,
    opts.model,
    opts.language,
    additionalContext,
    opts.tone,
    opts.verbosity,
    opts.instructions,
    includeTitleSlide,
    includeToc,
  );

  // ── TOC parity: inject TOC outline entries ─────────────────────────────────
  const nTocSlides = includeToc
    ? getNoOfTocRequiredForNOutlines({
        n_outlines: outline.slides.length,
        title_slide: includeTitleSlide,
        target_total_slides: opts.n_slides ?? undefined,
      })
    : 0;

  const augmentedOutline =
    nTocSlides > 0
      ? getPresentationOutlineModelWithToc({ outline, n_toc_slides: nTocSlides, title_slide: includeTitleSlide })
      : outline;

  // ── Generate structure ─────────────────────────────────────────────────────
  let structure: number[];
  if (layoutModel.ordered) {
    structure = layoutToStructure(layoutModel).slides;
  } else {
    const structureModel = await generatePresentationStructure(
      deps,
      augmentedOutline,
      layoutModel,
      opts.provider,
      opts.model,
      opts.instructions,
      opts.content,
    );
    structure = structureModel.slides;
  }

  // ── TOC parity: insert TOC layout indices into structure ───────────────────
  if (nTocSlides > 0) {
    const tocLayoutIndex = findTocLayoutIndex(layoutModel);
    const structureModel: PresentationStructureModel = { slides: structure };
    insertTocLayouts(structureModel, nTocSlides, includeTitleSlide, tocLayoutIndex);
    structure = structureModel.slides;
  }

  structure = clampStructureToOutline(structure, augmentedOutline.slides.length, layoutModel.slides.length);

  // ── Generate per-slide content ─────────────────────────────────────────────
  const slides: GeneratedSlide[] = [];
  for (let i = 0; i < augmentedOutline.slides.length; i++) {
    const layoutIndex = structure[i] ?? 0;
    const slideLayout = layoutModel.slides[layoutIndex];
    if (!slideLayout) {
      slides.push({ layout: String(layoutIndex), content: {}, ui: null });
      continue;
    }
    const content = await getSlideContentFromTypeAndOutline(
      deps,
      slideLayout,
      augmentedOutline.slides[i].content,
      opts.provider,
      opts.model,
      opts.language,
      opts.tone,
      opts.verbosity,
      opts.instructions,
      i + 1,
    );
    const rawLayouts = Array.isArray(layoutPayload.layouts) ? (layoutPayload.layouts as unknown[]) : [];
    const rawLayout = rawLayouts.find((l: unknown) => String((l as any)?.id) === String(slideLayout.id));
    const ui = hydrateTemplateSlideUi(rawLayout ?? null, slideLayout.id, content, layoutPayload);

    // Resolve image/icon prompts embedded in the content into real asset URLs.
    await processSlideAndFetchAssets(
      { content, ui },
      undefined,
      layoutModel.icon_weight,
      /* allowImageFallback */ true,
    );

    slides.push({ layout: slideLayout.id, content, ui });
  }

  const title = getPresentationTitleFromOutline(augmentedOutline);
  return { title, template: opts.template, language: opts.language ?? undefined, slides };
}

export function buildUploadedTemplatePrompt(opts: {
  document_text: string;
  document_name?: string;
  extra_instructions?: string | null;
}): string {
  const name = opts.document_name ?? "uploaded document";
  const extra = opts.extra_instructions ? `\nUser instructions: ${opts.extra_instructions}` : "";
  return `Create a presentation based on the following document: "${name}".\n\nDocument content:\n${opts.document_text}${extra}`;
}
