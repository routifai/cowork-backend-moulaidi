import { send } from "../../protocol.js";
import { getDb } from "../db/index.js";

export async function handlePresentingGetPresentation(cmd: Record<string, unknown>): Promise<void> {
  const id = String(cmd.id ?? "unknown");
  const presentationId = cmd.presentationId as string | undefined;
  if (!presentationId) {
    send({ type: "error", id, message: "get_presentation requires presentationId" });
    return;
  }
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM presentations WHERE id = ?").get(presentationId) as any;
    if (!row) {
      send({ type: "error", id, message: `Presentation ${presentationId} not found` });
      return;
    }
    const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(presentationId) as any[];
    const layout = row.layout ? JSON.parse(row.layout) : null;
    const data = {
      id: row.id,
      presentation_id: row.id,
      title: row.title ?? null,
      template: layout?.template_id ?? layout?.name ?? slides[0]?.layout_group ?? null,
      language: row.language ?? null,
      n_slides: slides.length,
      layout,
      slides: slides.map((s) => ({
        id: s.id,
        layout: s.layout ?? null,
        layout_group: s.layout_group ?? null,
        index: s.slide_index,
        content: s.content ? JSON.parse(s.content) : {},
        ui: s.ui ? JSON.parse(s.ui) : null,
        html_content: s.html_content ?? null,
        properties: s.properties ? JSON.parse(s.properties) : null,
        speaker_note: s.speaker_note ?? null,
      })),
    };
    send({ type: "result", id, data });
  } catch (err) {
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
}
