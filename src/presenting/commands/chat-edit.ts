/**
 * Handler for the `presenting_chat_edit` command.
 * Port of presenting/engine/commands/handlers/chat.py
 */

import { send } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { PresentationChatService, PresentationNotFoundError } from "../chat/service.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

export async function handlePresentingChatEdit(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
  const cmdId = String(cmd.id ?? "unknown");
  const presentationId = String(cmd.presentationId ?? cmd.presentation_id ?? "");
  const message = String(cmd.message ?? "");
  const provider = String(cmd.provider ?? "");
  const model = String(cmd.model ?? "");

  const missing = [
    ...(presentationId ? [] : ["presentationId"]),
    ...(message ? [] : ["message"]),
    ...(provider ? [] : ["provider"]),
    ...(model ? [] : ["model"]),
  ];
  if (missing.length) {
    send({ type: "result", id: cmdId, data: { error: `presenting_chat_edit requires: ${missing.join(", ")}` } });
    return;
  }

  const conversationId = cmd.conversationId != null ? String(cmd.conversationId) : null;

  try {
    const chatService = new PresentationChatService({
      presentationId,
      conversationId,
      provider,
      model,
      modelRuntime: deps.modelRuntime,
      modelRegistry: deps.modelRegistry,
      chatMode: (cmd.chatMode ?? cmd.chat_mode ?? "presentation") as "presentation" | "outline",
    });
    const attachments = Array.isArray(cmd.attachments)
      ? (cmd.attachments as Array<Record<string, unknown>>)
          .map((a) => ({
            name: typeof a.name === "string" ? a.name : undefined,
            filePath: String(a.filePath ?? a.file_path ?? ""),
          }))
          .filter((a) => a.filePath)
      : [];
    const result = await chatService.generateReply(message, attachments);

    // Store the chat turn in memory for future context retrieval (Phase 5)
    if (result.toolCalls.length > 0) {
      PRESENTATION_MEMORY_SERVICE.storeSlideEdit({
        presentationId,
        editPrompt: message,
        editedSlideContent: result.toolCalls.join(", "),
      });
    }

    send({
      type: "result",
      id: cmdId,
      data: { conversation_id: result.conversationId, response: result.responseText, tool_calls: result.toolCalls },
    });
  } catch (exc) {
    if (exc instanceof PresentationNotFoundError) {
      send({ type: "result", id: cmdId, data: { error: String(exc) } });
    } else {
      send({ type: "result", id: cmdId, data: { error: `presenting_chat_edit: ${String(exc)}` } });
    }
  }
}
