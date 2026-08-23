/**
 * Chat conversation history persistence using better-sqlite3.
 * Port of presenting/engine/services/chat/sql_chat_history.py — synchronous
 * variant (better-sqlite3 is synchronous, matching our DB layer pattern).
 */

import { randomUUID } from "crypto";
import { getDb } from "../db/index.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      presentation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_history_lookup
    ON chat_history (presentation_id, conversation_id, position)
  `);
}

let tableReady = false;
function ensureTableOnce(): void {
  if (tableReady) return;
  ensureTable();
  tableReady = true;
}

export function loadMessages(presentationId: string, conversationId: string): ChatMessage[] {
  ensureTableOnce();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM chat_history
       WHERE presentation_id = ? AND conversation_id = ?
       ORDER BY position ASC`,
    )
    .all(presentationId, conversationId) as Array<{ role: string; content: string }>;
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

export function appendTurn(
  presentationId: string,
  conversationId: string,
  userMessage: string,
  assistantMessage: string,
  toolCalls?: string[],
): void {
  ensureTableOnce();
  const db = getDb();
  const maxRow = db
    .prepare(
      `SELECT MAX(position) as mp FROM chat_history
       WHERE presentation_id = ? AND conversation_id = ?`,
    )
    .get(presentationId, conversationId) as { mp: number | null };
  const nextPosition = (maxRow?.mp ?? 0) + 1;
  const now = new Date().toISOString();

  const insert = db.prepare(
    `INSERT INTO chat_history (presentation_id, conversation_id, position, role, content, tool_calls, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(presentationId, conversationId, nextPosition, "user", userMessage, null, now);
  insert.run(
    presentationId,
    conversationId,
    nextPosition + 1,
    "assistant",
    assistantMessage,
    toolCalls ? JSON.stringify(toolCalls) : null,
    now,
  );
}

export function ensureConversationId(_presentationId: string, conversationId: string | null | undefined): string {
  return conversationId || randomUUID();
}

/** Phase 5: retrieve relevant past context from the memory layer. */
export async function retrieveSemanticContext(presentationId: string, _conversationId: string, query: string): Promise<string> {
  try {
    const { PRESENTATION_MEMORY_SERVICE } = await import("../services/memory-layer.js");
    return PRESENTATION_MEMORY_SERVICE.retrieveContext(presentationId, query);
  } catch {
    return "";
  }
}

export class ChatConversationStore {
  loadHistory(presentationId: string, conversationId: string): ChatMessage[] {
    return loadMessages(presentationId, conversationId);
  }

  appendTurn(
    presentationId: string,
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
    toolCalls?: string[],
  ): void {
    appendTurn(presentationId, conversationId, userMessage, assistantMessage, toolCalls);
  }

  async retrieveSemanticContext(_presentationId: string, _conversationId: string, _query: string): Promise<string> {
    return "";
  }

  ensureConversationId(presentationId: string, conversationId: string | null | undefined): string {
    return ensureConversationId(presentationId, conversationId);
  }
}
