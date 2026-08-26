import { send, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { initDb, getDb } from "../db/index.js";
import { saveGeneratedSmartPresentation } from "../db/presentation-store.js";
import { generateSmartPresentation, SmartGenerationError } from "../services/smart-generation.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

export function buildUploadedTemplatePrompt(opts: {
  document_text: string;
  document_name?: string;
  extra_instructions?: string | null;
}): string {
  const name = opts.document_name ?? "uploaded document";
  const extra = opts.extra_instructions ? `\nUser instructions: ${opts.extra_instructions}` : "";
  return `Create a presentation based on the following document: "${name}".\n\nDocument content:\n${opts.document_text}${extra}`;
}

export async function handlePresentingStartGeneration(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
  const id = String(cmd.id ?? "unknown");
  let content = cmd.content as string | undefined;
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

  const missing = (["content", "provider", "model"] as const).filter((k) => !{ content, provider, model }[k]);
  if (missing.length) {
    send({ type: "error", id, message: `start_generation requires: ${missing.join(", ")}` });
    return;
  }

  try {
    const result = await generateSmartPresentation(deps, {
      content: content!,
      provider: provider!,
      model: model!,
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
        template: "smart",
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
      logError("start_generation[%s]: %s", id, err instanceof Error ? err.message : String(err));
      send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
