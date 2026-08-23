/**
 * Handler for the `presenting_edit_slide` command.
 * Port of presenting/engine/commands/handlers/edit.py
 *
 * Direct (non-LLM) access to the same editing tools that chat_edit uses,
 * for the editor's own micro-interactions (drag, resize, type a character).
 * No model call, no conversation history — the tool name and args come
 * directly from the frontend.
 */

import { send, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { PresentationContextStore } from "../db/presentation-context.js";
import { ChatTools } from "../chat/tools.js";
import type { ToolCall } from "../chat/llm-tool-types.js";
import { initDb } from "../db/index.js";

export async function handlePresentingEditSlide(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
  const cmdId = String(cmd.id ?? "unknown");
  const presentationId = String(cmd.presentationId ?? cmd.presentation_id ?? "");
  const toolName = String(cmd.tool ?? "");
  const toolArgs = cmd.args != null && typeof cmd.args === "object" ? (cmd.args as Record<string, unknown>) : {};

  const missing = [...(presentationId ? [] : ["presentationId"]), ...(toolName ? [] : ["tool"])];
  if (missing.length) {
    send({ type: "result", id: cmdId, data: { error: `presenting_edit_slide requires: ${missing.join(", ")}` } });
    return;
  }
  if (cmd.args != null && (typeof cmd.args !== "object" || Array.isArray(cmd.args))) {
    send({ type: "result", id: cmdId, data: { error: "presenting_edit_slide 'args' must be an object" } });
    return;
  }

  try {
    initDb();
    const memory = new PresentationContextStore(presentationId, "standard", {
      hypatiaDir: deps.hypatiaDir,
      workspaceCwd: deps.workspaceCwd,
    });
    const tools = new ChatTools(memory);
    const toolCall: ToolCall = { id: cmdId, name: toolName, arguments: JSON.stringify(toolArgs) };
    const result = await tools.executeToolCall(toolCall);
    send({ type: "result", id: cmdId, data: result });
  } catch (exc) {
    logError("presenting_edit_slide[%s] tool=%s: %s", cmdId, toolName, exc instanceof Error ? exc.message : String(exc));
    send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
  }
}
