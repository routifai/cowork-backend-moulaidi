/**
 * Handler for the `presenting_export_presentation` command.
 * Port of presenting/engine/commands/handlers/export.py
 */

import { send, logError } from "../../protocol.js";
import { exportPresentationToPptx, PresentationNotFoundForExportError, ExportRuntimeError } from "../services/export.js";
import { initDb } from "../db/index.js";

export async function handlePresentingExportPresentation(cmd: Record<string, unknown>): Promise<void> {
  const cmdId = String(cmd.id ?? "unknown");
  const presentationId = String(cmd.presentationId ?? cmd.presentation_id ?? "");
  const outputPath = String(cmd.outputPath ?? cmd.output_path ?? "");

  const missing = [...(presentationId ? [] : ["presentationId"]), ...(outputPath ? [] : ["outputPath"])];
  if (missing.length) {
    send({ type: "result", id: cmdId, data: { error: `presenting_export_presentation requires: ${missing.join(", ")}` } });
    return;
  }

  try {
    initDb();
    const resultPath = await exportPresentationToPptx({ presentationId, outputPath });
    send({ type: "result", id: cmdId, data: { path: resultPath } });
  } catch (exc) {
    if (exc instanceof PresentationNotFoundForExportError) {
      send({ type: "result", id: cmdId, data: { error: String(exc) } });
    } else {
      logError("presenting_export_presentation[%s]: %s", cmdId, exc instanceof Error ? exc.message : String(exc));
      send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
    }
  }
}
