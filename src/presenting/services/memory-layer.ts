/**
 * Lightweight mem0 replacement for presentation chat memory.
 * Port of presenting/engine/services/mem0_presentation_memory_service.py
 * and mem0_oss_memory.py.
 *
 * Storage: better-sqlite3 (synchronous, same DB as the rest of the presenting layer)
 * Retrieval: keyword TF-IDF scoring with optional @xenova/transformers cosine similarity
 *   when the model is available (graceful degradation — works out of the box without
 *   any model download, same pattern as icon-finder-service).
 */

import { getDb } from "../db/index.js";

const TOP_K = parseInt(process.env.MEM0_TOP_K ?? "8", 10) || 8;
const MAX_CONTEXT_CHARS = parseInt(process.env.MEM0_MAX_CONTEXT_CHARS ?? "6000", 10) || 6000;
const ENABLED = (process.env.MEM0_ENABLED ?? "true").trim().toLowerCase() !== "false";
const NAMESPACE_PREFIX = (process.env.MEM0_PRESENTATION_NAMESPACE_PREFIX || "presentation").trim() || "presentation";
const MAX_CHUNK_CHARS = 20000;

// ── DB setup ──────────────────────────────────────────────────────────────────

let tableReady = false;
function ensureTable(): void {
  if (tableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS presentation_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      chunk TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_presentation_memory_ns
      ON presentation_memory (namespace);
  `);
  tableReady = true;
}

function scopeNamespace(presentationId: string): string {
  return `${NAMESPACE_PREFIX}:${presentationId}`;
}

function truncate(text: string, limit = MAX_CHUNK_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[TRUNCATED]`;
}

function addChunk(namespace: string, chunk: string): void {
  if (!chunk.trim()) return;
  getDb().prepare("INSERT INTO presentation_memory (namespace, chunk) VALUES (?, ?)").run(namespace, truncate(chunk));
}

function loadChunks(namespace: string): string[] {
  const rows = getDb().prepare("SELECT chunk FROM presentation_memory WHERE namespace = ? ORDER BY id ASC").all(namespace) as Array<{ chunk: string }>;
  return rows.map((r) => r.chunk);
}

// ── Keyword scoring (always available) ────────────────────────────────────────

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

function keywordScore(chunk: string, queryTokens: Set<string>): number {
  if (!queryTokens.size) return 0;
  const chunkTokens = tokenize(chunk);
  let score = 0;
  for (const token of chunkTokens) { if (queryTokens.has(token)) score++; }
  return chunkTokens.length > 0 ? score / Math.sqrt(chunkTokens.length) : 0;
}

function retrieveByKeyword(chunks: string[], query: string, topK: number): string[] {
  const queryTokens = new Set(tokenize(query));
  const scored = chunks.map((chunk, idx) => [keywordScore(chunk, queryTokens), idx] as [number, number]);
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, topK).filter(([s]) => s > 0).map(([, idx]) => chunks[idx]);
}

// ── Optional: @xenova/transformers cosine similarity ──────────────────────────

let embeddingPipeline: any = null;
let embeddingLoadAttempted = false;

async function getEmbeddingPipeline(): Promise<any> {
  if (embeddingLoadAttempted) return embeddingPipeline;
  embeddingLoadAttempted = true;
  try {
    // @ts-ignore — optional dep
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = false;
    embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  } catch {
    // Not installed — keyword fallback is used
    embeddingPipeline = null;
  }
  return embeddingPipeline;
}

async function embed(pipe: any, text: string): Promise<Float32Array> {
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

async function retrieveBySemantic(chunks: string[], query: string, topK: number): Promise<string[]> {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return retrieveByKeyword(chunks, query, topK);
  try {
    const queryVec = await embed(pipe, query);
    const scored: Array<[number, number]> = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkVec = await embed(pipe, chunks[i].slice(0, 512));
      scored.push([cosine(queryVec, chunkVec), i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, topK).filter(([s]) => s > 0).map(([, idx]) => chunks[idx]);
  } catch {
    return retrieveByKeyword(chunks, query, topK);
  }
}

// ── Public service ─────────────────────────────────────────────────────────────

class PresentationMemoryService {
  private readonly _enabled: boolean;

  constructor() {
    this._enabled = ENABLED;
  }

  private _store(presentationId: string, chunk: string): void {
    if (!this._enabled || !chunk.trim()) return;
    try {
      ensureTable();
      addChunk(scopeNamespace(presentationId), chunk);
    } catch { /* non-fatal */ }
  }

  storeGenerationContext(opts: {
    presentationId: string;
    systemPrompt?: string | null;
    userPrompt?: string | null;
    extractedDocumentText?: string | null;
    sourceContent?: string | null;
    instructions?: string | null;
  }): void {
    const { presentationId, systemPrompt, userPrompt, extractedDocumentText, sourceContent, instructions } = opts;
    if (sourceContent) this._store(presentationId, `[presentation_source_prompt]\n${sourceContent}`);
    if (instructions) this._store(presentationId, `[presentation_generation_instructions]\n${instructions}`);
    if (systemPrompt) this._store(presentationId, `[outline_system_prompt]\n${systemPrompt}`);
    if (userPrompt) this._store(presentationId, `[outline_user_prompt]\n${userPrompt}`);
    if (extractedDocumentText) this._store(presentationId, `[document_extracted_text]\n${extractedDocumentText}`);
  }

  storeGeneratedOutlines(presentationId: string, outlines: unknown): void {
    if (outlines == null) return;
    let text: string;
    try { text = typeof outlines === "string" ? outlines : JSON.stringify(outlines); }
    catch { text = String(outlines); }
    this._store(presentationId, `[generated_outlines]\n${text}`);
  }

  storeSlideEdit(opts: { presentationId: string; slideIndex?: number | null; editPrompt: string; editedSlideContent: unknown }): void {
    const { presentationId, slideIndex, editPrompt, editedSlideContent } = opts;
    let editedText: string;
    try { editedText = typeof editedSlideContent === "string" ? editedSlideContent : JSON.stringify(editedSlideContent); }
    catch { editedText = String(editedSlideContent); }
    const indexText = slideIndex != null ? String(slideIndex) : "unknown";
    this._store(presentationId, `[slide_edit]\nslide_index=${indexText}\nuser_edit_prompt=${editPrompt}\nedited_slide_content=${editedText}`);
  }

  async retrieveContext(presentationId: string, query: string): Promise<string> {
    if (!this._enabled || !query.trim()) return "";
    try {
      ensureTable();
      const chunks = loadChunks(scopeNamespace(presentationId));
      if (!chunks.length) return "";
      const results = await retrieveBySemantic(chunks, query, TOP_K);
      if (!results.length) return "";
      const deduped = [...new Set(results.map((r) => r.trim()).filter(Boolean))];
      const context = deduped.join("\n\n");
      return context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n\n[TRUNCATED]` : context;
    } catch { return ""; }
  }

  clearPresentation(presentationId: string): void {
    if (!this._enabled) return;
    try {
      ensureTable();
      getDb().prepare("DELETE FROM presentation_memory WHERE namespace = ?").run(scopeNamespace(presentationId));
    } catch { /* non-fatal */ }
  }
}

export const PRESENTATION_MEMORY_SERVICE = new PresentationMemoryService();
