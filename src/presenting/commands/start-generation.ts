import { send, log, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { initDb, getDb } from "../db/index.js";
import { saveGeneratedPresentation, saveGeneratedSmartPresentation } from "../db/presentation-store.js";
import { generatePresentation, buildUploadedTemplatePrompt, TemplateNotFoundError } from "../services/generation.js";
import { generateSmartPresentation, SmartGenerationError } from "../services/smart-generation.js";
import { resolveTemplateData } from "../services/template-resolver.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

/** Reserved template id — routes to Smart generation (raw LLM-written HTML per slide) instead of the TemplateV2 JSON element-tree path. Never a real Preset/Imported Template id (those are bare names or "imported:<uuid>"). */
const SMART_TEMPLATE_SENTINEL = "smart";

async function handleSmartGeneration(deps: HandlerDependencies, cmd: Record<string, unknown>, id: string, content: string): Promise<void> {
  try {
    const result = await generateSmartPresentation(deps, {
      content,
      provider: cmd.provider as string,
      model: cmd.model as string,
      n_slides: cmd.nSlides as number | undefined,
      language: cmd.language as string | undefined,
      tone: cmd.tone as string | undefined,
      verbosity: cmd.verbosity as string | undefined,
      instructions: cmd.instructions as string | undefined,
      include_title_slide: cmd.includeTitleSlide !== false,
      include_table_of_contents: Boolean(cmd.includeTableOfContents),
    });

    initDb();
    const presentationId = saveGeneratedSmartPresentation(result);

    PRESENTATION_MEMORY_SERVICE.storeGenerationContext({
      presentationId,
      sourceContent: content,
      instructions: cmd.instructions as string | undefined,
    });

    const db = getDb();
    const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(presentationId) as any[];
    send({
      type: "result",
      id,
      data: {
        id: presentationId,
        presentation_id: presentationId,
        title: result.title,
        template: SMART_TEMPLATE_SENTINEL,
        language: cmd.language ?? null,
        n_slides: slides.length,
        layout: null,
        theme: null,
        fonts: null,
        generation_mode: "smart",
        version: "v2-smart",
        slides: slides.map((s) => ({
          id: s.id,
          index: s.slide_index,
          layout: s.layout ?? null,
          layout_group: s.layout_group ?? null,
          content: {},
          ui: null,
          html_content: s.html_content ?? null,
          properties: null,
          speaker_note: s.speaker_note ?? null,
        })),
      },
    });
  } catch (err) {
    if (err instanceof SmartGenerationError) {
      send({ type: "error", id, message: String(err.message) });
    } else {
      logError("start_generation[smart][%s]: %s", id, err instanceof Error ? err.message : String(err));
      send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function handlePresentingStartGeneration(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
  const id = String(cmd.id ?? "unknown");
  let content = cmd.content as string | undefined;
  const template = cmd.template as string | undefined;
  const provider = cmd.provider as string | undefined;
  const model = cmd.model as string | undefined;

  const documentText = cmd.documentText as string | undefined;
  if (documentText) {
    content = buildUploadedTemplatePrompt({
      document_text: documentText,
      document_name: (cmd.documentName as string | undefined) ?? "uploaded document",
      extra_instructions: cmd.instructions as string | undefined,
    });
  }

  const missing = (["content", "template", "provider", "model"] as const).filter((k) => !{ content, template, provider, model }[k]);
  if (missing.length) {
    send({ type: "error", id, message: `start_generation requires: ${missing.join(", ")}` });
    return;
  }

  if (template === SMART_TEMPLATE_SENTINEL) {
    await handleSmartGeneration(deps, cmd, id, content!);
    return;
  }

  try {
    const result = await generatePresentation(deps, {
      content: content!,
      template: template!,
      provider: provider!,
      model: model!,
      n_slides: cmd.nSlides as number | undefined,
      language: cmd.language as string | undefined,
      tone: cmd.tone as string | undefined,
      verbosity: cmd.verbosity as string | undefined,
      instructions: cmd.instructions as string | undefined,
      include_title_slide: cmd.includeTitleSlide !== false,
      include_table_of_contents: Boolean(cmd.includeTableOfContents),
      web_search: Boolean(cmd.webSearch),
      web_search_provider: (cmd.webSearchProvider as any) ?? "auto",
    });

    initDb();
    const presentationId = saveGeneratedPresentation(
      result as unknown as Record<string, unknown>,
      (name) => resolveTemplateData(name, deps),
    );

    // Store generation context in memory layer for later chat retrieval (Phase 5)
    PRESENTATION_MEMORY_SERVICE.storeGenerationContext({
      presentationId,
      sourceContent: content,
      instructions: cmd.instructions as string | undefined,
    });
    PRESENTATION_MEMORY_SERVICE.storeGeneratedOutlines(presentationId, (result as any).outline);

    send({ type: "result", id, data: { ...result, presentation_id: presentationId } });
  } catch (err) {
    if (err instanceof TemplateNotFoundError) {
      send({ type: "error", id, message: String(err.message) });
    } else {
      logError("start_generation[%s]: %s", id, err instanceof Error ? err.message : String(err));
      send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
