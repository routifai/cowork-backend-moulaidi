/**
 * Restores one slide to a previously-captured raw snapshot — a direct DB
 * write, no LLM call. Powers the chat panel's "keep original / keep edit"
 * comparison: the frontend snapshots every slide before sending a chat-edit
 * turn, diffs after the turn completes to find what actually changed, and
 * this command lets the user revert one of those changed slides back to its
 * pre-edit state on demand.
 */
import { send } from "../../protocol.js";
import { getDb } from "../db/index.js";

export async function handlePresentingRestoreSlide(cmd: Record<string, unknown>): Promise<void> {
  const id = String(cmd.id ?? "unknown");
  const presentationId = cmd.presentationId as string | undefined;
  const index = cmd.index as number | undefined;
  const snapshot = cmd.snapshot as Record<string, unknown> | undefined;
  if (!presentationId || index == null || !snapshot) {
    send({ type: "error", id, message: "presenting_restore_slide requires presentationId, index, and snapshot" });
    return;
  }

  try {
    const db = getDb();
    const existing = db
      .prepare("SELECT id FROM slides WHERE presentation_id = ? AND slide_index = ?")
      .get(presentationId, index) as { id: string } | undefined;
    if (!existing) {
      send({ type: "error", id, message: `No slide at index ${index}` });
      return;
    }

    const htmlContent = snapshot.htmlContent != null ? String(snapshot.htmlContent) : null;
    const content = snapshot.content != null ? JSON.stringify(snapshot.content) : "{}";
    const ui = snapshot.ui != null ? JSON.stringify(snapshot.ui) : null;
    const speakerNote = snapshot.speakerNote != null ? String(snapshot.speakerNote) : null;

    db.prepare("UPDATE slides SET content = ?, ui = ?, html_content = ?, speaker_note = ? WHERE presentation_id = ? AND slide_index = ?").run(
      content,
      ui,
      htmlContent,
      speakerNote,
      presentationId,
      index,
    );

    send({ type: "result", id, data: { restored: true, index } });
  } catch (err) {
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
}
