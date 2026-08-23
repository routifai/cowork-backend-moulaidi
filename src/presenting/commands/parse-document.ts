/**
 * Handler for the `presenting_parse_document` command.
 * Port of presenting/engine/commands/handlers/upload.py
 */

import { existsSync } from "fs";
import { basename } from "path";
import { send, logError } from "../../protocol.js";
import { extractDocumentText, DocumentLoadError } from "../services/documents-loader.js";

export async function handlePresentingParseDocument(cmd: Record<string, unknown>): Promise<void> {
  const cmdId = String(cmd.id ?? "unknown");
  const filePath = String(cmd.filePath ?? cmd.file_path ?? "");
  if (!filePath) {
    send({ type: "result", id: cmdId, data: { error: "presenting_parse_document requires: filePath" } });
    return;
  }
  if (!existsSync(filePath)) {
    send({ type: "result", id: cmdId, data: { error: `File not found: ${filePath}` } });
    return;
  }
  try {
    const text = await extractDocumentText(filePath, cmd.language as string | null ?? null);
    send({ type: "result", id: cmdId, data: { text, name: basename(filePath) } });
  } catch (exc) {
    if (exc instanceof DocumentLoadError) {
      send({ type: "result", id: cmdId, data: { error: String(exc) } });
    } else {
      logError("presenting_parse_document[%s]: %s", cmdId, exc instanceof Error ? exc.message : String(exc));
      send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
    }
  }
}
