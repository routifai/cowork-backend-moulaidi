/**
 * Tool/ToolCall types for the pi-ai relay.
 * Port of presenting/engine/services/chat/llm_tool_types.py.
 */

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-stringified arguments (re-serialized from pi-ai's parsed object). */
  arguments: string;
}

export function makeToolCall(block: Record<string, unknown>): ToolCall {
  return {
    id: String(block.id ?? ""),
    name: String(block.name ?? ""),
    arguments: JSON.stringify(block.arguments ?? {}),
  };
}

export function extractToolCalls(assistantMessage: unknown): ToolCall[] {
  if (!assistantMessage || typeof assistantMessage !== "object") return [];
  const content = (assistantMessage as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && (b as any).type === "toolCall")
    .map(makeToolCall);
}

export function extractText(assistantMessage: unknown): string {
  if (!assistantMessage || typeof assistantMessage !== "object") return "";
  const content = (assistantMessage as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && (b as any).type === "text")
    .map((b) => String((b as any).text ?? ""))
    .join("");
}
