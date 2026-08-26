/**
 * Direct manual text edit → whole-slide HTML save, no LLM call. Powers
 * SmartSlideRenderer's contenteditable text leaves (mirrors Presenton's own
 * SmartHtmlEditor.tsx: click into text, type, blur saves). Reuses
 * PresentationContextStore's existing saveSlide (the same validated path
 * chat-driven saveSlide already uses) rather than a raw DB write, so a
 * manual edit gets the same sanitization Smart HTML always gets — script
 * stripping, canvas-class check, etc.
 */
import { send } from "../../protocol.js";
import { PresentationContextStore } from "../db/presentation-context.js";

export async function handlePresentingSaveSlideHtml(cmd: Record<string, unknown>): Promise<void> {
	const id = String(cmd.id ?? "unknown");
	const presentationId = cmd.presentationId as string | undefined;
	const index = cmd.index as number | undefined;
	const html = cmd.html as string | undefined;
	if (!presentationId || index == null || html == null) {
		send({ type: "error", id, message: "presenting_save_slide_html requires presentationId, index, and html" });
		return;
	}

	try {
		const store = new PresentationContextStore(presentationId);
		const result = await store.saveSlide({ html, index, replaceOldSlideAtIndex: true });
		send({ type: "result", id, data: result });
	} catch (err) {
		send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
	}
}
