/**
 * Chat-driven presentation editing: LLM tool-calling orchestration loop.
 * Port of presenting/engine/services/chat/service.py (PresentationChatService)
 * plus Presenton's chat-attachment parity (parse attached documents into
 * the model context when the user is asking about their contents).
 */

import { basename } from "node:path";
import { PresentationContextStore } from "../db/presentation-context.js";
import { ensureConversationId, loadMessages, appendTurn, retrieveSemanticContext } from "./conversation-store.js";
import { extractText, extractToolCalls } from "./llm-tool-types.js";
import { buildSystemPrompt } from "./prompts.js";
import { ChatTools, type ChatToolMode } from "./tools.js";
import { getDb } from "../db/index.js";
import { extractDocumentText } from "../services/documents-loader.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

export interface ChatAttachment {
  name?: string;
  filePath: string;
}

const MAX_CHAT_ATTACHMENT_CONTEXT_CHARS = 6000;
const MAX_CHAT_ATTACHMENT_FILE_CHARS = 3000;
const DOCUMENT_CONTENT_INTENT =
  /\b(read|extract|parse|analy[sz]e|summari[sz]e|review|reference|cite|quote|compare|content|from|data|numbers?|metrics?|table|chart|outline|presentation|create|generate|build|draft|write|convert)\b|\bbased\s+on\b|\baccording\s+to\b|\buse\s+(?:the\s+)?(?:attached|provided|this)\s+(?:document|pdf|file|attachment)\b/i;
const DIRECT_FILE_PLACEMENT = /\b(place|put|insert|attach|display|show|move|resize|position|replace|add)\b/i;

const MAX_TOOL_ROUNDS = 40;

export class PresentationNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = "PresentationNotFoundError"; }
}

export interface ChatTurnResult {
  conversationId: string;
  responseText: string;
  toolCalls: string[];
}

export class PresentationChatService {
  private readonly _presentationId: string;
  private readonly _conversationId: string | null;
  private readonly _provider: string;
  private readonly _model: string;
  private readonly _memory: PresentationContextStore;
  private readonly _tools: ChatTools;
  private readonly _modelRuntime: any;
  private readonly _modelRegistry: any;

  constructor(opts: {
    presentationId: string;
    conversationId?: string | null;
    provider: string;
    model: string;
    modelRuntime: any;
    modelRegistry: any;
    chatMode?: ChatToolMode;
  }) {
    this._presentationId = opts.presentationId;
    this._conversationId = opts.conversationId ?? null;
    this._provider = opts.provider;
    this._model = opts.model;
    this._modelRuntime = opts.modelRuntime;
    this._modelRegistry = opts.modelRegistry;
    this._memory = new PresentationContextStore(this._presentationId);
    this._tools = new ChatTools(this._memory, opts.chatMode ?? "presentation");
  }

  async generateReply(userMessage: string, attachments: ChatAttachment[] = []): Promise<ChatTurnResult> {
    this._tools.setTurnContext(userMessage);
    const { conversationId, messages, persistedUserMessage } = await this._prepareTurnContext(userMessage, attachments);
    const { responseText, toolCalls } = await this._runLlmWithTools(messages);
    return this._persistTurn({ conversationId, userMessage: persistedUserMessage, responseText, toolCalls });
  }

  private async _prepareTurnContext(userMessage: string, attachments: ChatAttachment[]): Promise<{
    conversationId: string;
    messages: Array<Record<string, unknown>>;
    persistedUserMessage: string;
  }> {
    if (!userMessage?.trim() && attachments.length === 0) throw new Error("Message is required");

    const db = getDb();
    const presentation = db.prepare("SELECT id, generation_mode, language FROM presentations WHERE id = ?").get(this._presentationId) as any;
    if (!presentation) throw new PresentationNotFoundError("Presentation not found");
    if (presentation.generation_mode !== "smart") {
      throw new Error("Presentation is not a Smart-mode deck.");
    }

    const conversationId = ensureConversationId(this._presentationId, this._conversationId);
    const history = loadMessages(this._presentationId, conversationId);
    const historyMessages = this._convertHistoryToMessages(history);

    const normalizedUserMessage = stripUiContextPrefix(userMessage);
    const { context: attachmentContext, memory: attachmentMemory } = await this._buildAttachmentContext(
      userMessage,
      attachments,
      presentation.language ?? null,
    );
    if (attachmentMemory) {
      PRESENTATION_MEMORY_SERVICE.storeGenerationContext({
        presentationId: this._presentationId,
        extractedDocumentText: attachmentMemory,
      });
    }

    const presentationMemory = await this._memory.retrieveContext(normalizedUserMessage || userMessage);
    const chatMemory = await retrieveSemanticContext(this._presentationId, conversationId, normalizedUserMessage || userMessage);
    const systemPrompt = buildSystemPrompt(presentationMemory, chatMemory);
    const composedUserMessage = composeUserMessageForModel(userMessage || "Please use the attached document(s).", attachmentContext);

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: [{ type: "text", text: composedUserMessage }] },
    ];
    return {
      conversationId,
      messages,
      persistedUserMessage: persistedUserMessage(userMessage, attachments),
    };
  }

  private async _buildAttachmentContext(
    userMessage: string,
    attachments: ChatAttachment[],
    language: string | null,
  ): Promise<{ context: string; memory: string }> {
    if (!attachments.length) return { context: "", memory: "" };

    const names = attachments.map((a, i) => `Document ${i + 1}: ${attachmentDisplayName(a)}`);
    if (!shouldParseAttachments(userMessage, attachments)) {
      return {
        context: [
          "UI context: the user attached document file(s), but this request appears to place or reference the file rather than read its contents. Use only the file names unless the user asks to read, extract, summarize, or build from them.",
          ...names,
        ].join("\n"),
        memory: "",
      };
    }

    const contextLines = [
      "UI context: the user attached parsed document(s) to this chat request. Use this content when the user asks to read, extract, summarize, or build slide/chart/data content from attachments.",
    ];
    const memoryLines: string[] = [];
    let remaining = MAX_CHAT_ATTACHMENT_CONTEXT_CHARS;

    for (let i = 0; i < attachments.length; i++) {
      if (remaining <= 0) {
        contextLines.push("[Additional attachment content omitted]");
        break;
      }
      const name = attachmentDisplayName(attachments[i]);
      let parsed = "";
      try {
        parsed = await extractDocumentText(attachments[i].filePath, language);
      } catch (err) {
        parsed = `[Failed to parse attachment: ${err instanceof Error ? err.message : String(err)}]`;
      }
      const trimmed = trimAttachmentText(parsed, Math.min(MAX_CHAT_ATTACHMENT_FILE_CHARS, remaining));
      contextLines.push(`Document ${i + 1} (${name}):\n${trimmed}`);
      memoryLines.push(`Document ${i + 1} (${name}):\n${trimmed}`);
      remaining -= trimmed.length;
    }

    return { context: contextLines.join("\n"), memory: memoryLines.join("\n\n").trim() };
  }

  private async _runLlmWithTools(messages: Array<Record<string, unknown>>): Promise<{ responseText: string; toolCalls: string[] }> {
    const systemPrompt = messages[0]?.content as string ?? "";
    const conversationMessages = [...messages.slice(1)];
    const toolDicts = this._tools.getToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const calledTools: string[] = [];
    let lastToolResults: Array<Record<string, unknown>> = [];

    const found = this._modelRegistry.find(this._provider, this._model);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const assistantMessage = await this._modelRuntime.completeSimple(found, {
        systemPrompt,
        messages: conversationMessages,
        tools: toolDicts,
      });

      const toolCalls = extractToolCalls(assistantMessage);
      if (!toolCalls.length) {
        const responseText = extractText(assistantMessage) || "I could not generate a response for that request.";
        return { responseText, toolCalls: calledTools };
      }

      calledTools.push(...toolCalls.map((tc) => tc.name));
      conversationMessages.push(assistantMessage);

      lastToolResults = [];
      for (const toolCall of toolCalls) {
        const toolResult = await this._tools.executeToolCall(toolCall);
        lastToolResults.push(toolResult);
        conversationMessages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: JSON.stringify(toolResult) }],
        });
      }
    }

    // Max tool rounds exceeded — try one final synthesis without tools
    const finalResponse = await this._tryFinalResponseWithoutTools(systemPrompt, conversationMessages, found);
    if (finalResponse) return { responseText: finalResponse, toolCalls: calledTools };
    return { responseText: buildToolLimitFallback(lastToolResults), toolCalls: calledTools };
  }

  private async _tryFinalResponseWithoutTools(
    systemPrompt: string,
    messages: Array<Record<string, unknown>>,
    found: unknown,
  ): Promise<string | null> {
    try {
      const assistantMessage = await this._modelRuntime.completeSimple(found, { systemPrompt, messages });
      return extractText(assistantMessage);
    } catch {
      return null;
    }
  }

  private _persistTurn(opts: { conversationId: string; userMessage: string; responseText: string; toolCalls: string[] }): ChatTurnResult {
    const clean = stripUiContextPrefix(opts.userMessage) || opts.userMessage;
    appendTurn(this._presentationId, opts.conversationId, clean, opts.responseText, opts.toolCalls);
    return { conversationId: opts.conversationId, responseText: opts.responseText, toolCalls: opts.toolCalls };
  }

  private _convertHistoryToMessages(history: Array<{ role: string; content: string }>): Array<Record<string, unknown>> {
    return history.map((h) => ({
      role: h.role,
      content: [{ type: "text", text: h.content }],
    }));
  }
}

export function stripUiContextPrefix(userMessage: string): string {
  const marker = "\nUser message:";
  if (!userMessage.startsWith("UI context:")) return userMessage.trim();
  const idx = userMessage.indexOf(marker);
  if (idx === -1) return userMessage.trim();
  return userMessage.slice(idx + marker.length).trimStart();
}

export function attachmentDisplayName(attachment: ChatAttachment): string {
  const name = (attachment.name ?? "").trim();
  if (name) return name;
  return basename(attachment.filePath || "").trim() || "attachment";
}

export function shouldParseAttachments(userMessage: string, attachments: ChatAttachment[]): boolean {
  if (!attachments.length) return false;
  const userText = stripUiContextPrefix(userMessage).trim();
  if (!userText) return true;
  if (DOCUMENT_CONTENT_INTENT.test(userText)) return true;
  if (DIRECT_FILE_PLACEMENT.test(userText)) return false;
  return true;
}

function trimAttachmentText(text: string, limit: number): string {
  const value = (text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n[Attachment truncated]`;
}

function composeUserMessageForModel(userMessage: string, attachmentContext: string): string {
  if (!attachmentContext) return userMessage;
  const marker = "\nUser message:";
  if (userMessage.startsWith("UI context:")) {
    const idx = userMessage.indexOf(marker);
    if (idx !== -1) {
      return `${userMessage.slice(0, idx).trimEnd()}\n${attachmentContext}\n${userMessage.slice(idx).trimStart()}`;
    }
  }
  return `${attachmentContext}\n\nUser message: ${userMessage}`;
}

function persistedUserMessage(userMessage: string, attachments: ChatAttachment[]): string {
  const display = stripUiContextPrefix(userMessage) || userMessage;
  if (!attachments.length) return display;
  const list = attachments.map(attachmentDisplayName).join(", ");
  return `${display}\n\nAttached files: ${list}`;
}

function buildToolLimitFallback(lastToolResults: Array<Record<string, unknown>>): string {
  const failed = lastToolResults.filter((r) => typeof r === "object" && !r.ok);
  if (failed.length) return `I ran into repeated tool errors (${failed[failed.length - 1].error ?? "unknown error"}) and couldn't finish this edit.`;
  return "I made several tool calls but couldn't produce a final answer — please try rephrasing the request.";
}
