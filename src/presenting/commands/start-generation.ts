import { send, log, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { initDb } from "../db/index.js";
import { saveGeneratedPresentation } from "../db/presentation-store.js";
import { generatePresentation, buildUploadedTemplatePrompt, TemplateNotFoundError } from "../services/generation.js";
import { resolveTemplateData } from "../services/template-resolver.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

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
