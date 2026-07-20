/**
 * Persistent project memory store.
 *
 * Cross-session memory for a workspace is kept as plain Markdown so users can
 * read, edit, and delete it outside the app. The always-loaded layer is a small
 * index file (`MEMORY.md`); per-topic detail lives in `notes/<topic>.md` and is
 * read on demand by the agent with its existing read tool.
 *
 * Layout:
 *   ~/.hypatiai/cowork/memory/<encoded-cwd>/MEMORY.md
 *   ~/.hypatiai/cowork/memory/<encoded-cwd>/notes/<topic>.md
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stable filename for the project-memory index inside the workspace memory dir. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** Subdirectory holding per-topic detail notes. */
export const MEMORY_NOTES_DIR = "notes";

/** Soft cap for the index file. When exceeded, tools nudge the model to consolidate. */
export const MEMORY_INDEX_SOFT_LINE_LIMIT = 150;
export const MEMORY_INDEX_SOFT_SIZE_LIMIT = 25 * 1024; // 25 KB

/** Max length for the one-line summary stored in the index. */
export const MEMORY_SUMMARY_MAX_LENGTH = 150;

export type MemoryType = "project" | "preference" | "decision";

export interface MemoryEntry {
	/** URL-safe slug, also the notes filename (without `.md`). */
	topic: string;
	/** One-line summary shown in the index. */
	summary: string;
	/** Optional memory category. */
	type?: MemoryType;
	/** ISO timestamp of the last update. */
	updatedAt: string;
}

/**
 * Encode a workspace path into a safe directory name, mirroring pi's own
 * session-dir sanitization so memory paths stay deterministic and portable.
 *
 * Source reference: pi SDK resolves cwd to a directory under `~/.pi/agent/sessions`
 * using the same `replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")` transform.
 */
export function encodeWorkspacePath(cwd: string): string {
	const normalized = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${normalized}--`;
}

/** Directory that holds memory files for a workspace. */
export function memoryDirForCwd(baseDir: string, cwd: string): string {
	return join(baseDir, "memory", encodeWorkspacePath(cwd));
}

/** Full path to the index file for a workspace. */
export function memoryIndexPath(baseDir: string, cwd: string): string {
	return join(memoryDirForCwd(baseDir, cwd), MEMORY_INDEX_FILENAME);
}

/** Full path to a detail note. */
export function memoryNotePath(baseDir: string, cwd: string, topic: string): string {
	return join(memoryDirForCwd(baseDir, cwd), MEMORY_NOTES_DIR, `${slugify(topic)}.md`);
}

/** Create a URL/filename-safe slug from a topic title. */
export function slugify(topic: string): string {
	return topic
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function parseIndexEntries(content: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		// Format: `- **[topic](notes/topic.md)** — summary *(updated: ISO)*`
		const match = trimmed.match(/^- \*\*\[([^\]]+)\]\(notes\/[^)]+\.md\)\*\* — (.+) \*\(updated: ([^)]+)\)\*$/);
		if (match) {
			const [, topic, summary, updatedAt] = match;
			const typeMatch = summary.match(/^\[(project|preference|decision)\] /);
			entries.push({
				topic,
				summary: typeMatch ? summary.slice(typeMatch[0].length) : summary,
				type: (typeMatch?.[1] as MemoryType) ?? undefined,
				updatedAt,
			});
		}
	}
	return entries;
}

function serializeIndexEntries(entries: MemoryEntry[]): string {
	if (entries.length === 0) {
		return "# Project memory\n\nNo memories recorded yet.\n";
	}
	const lines = ["# Project memory", ""];
	for (const entry of entries) {
		const slug = slugify(entry.topic);
		const typePrefix = entry.type ? `[${entry.type}] ` : "";
		lines.push(`- **[${entry.topic}](notes/${slug}.md)** — ${typePrefix}${entry.summary} *(updated: ${entry.updatedAt})*`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Load all memory index entries for a workspace.
 * Returns an empty array when no index exists.
 */
export function loadMemoryIndex(baseDir: string, cwd: string): MemoryEntry[] {
	const fp = memoryIndexPath(baseDir, cwd);
	if (!existsSync(fp)) return [];
	try {
		return parseIndexEntries(readFileSync(fp, "utf-8"));
	} catch {
		return [];
	}
}

/**
 * Upsert a memory entry. Overwrites an existing entry with the same topic slug.
 * Creates the index file and detail note if needed.
 *
 * Returns `{ ok: false, reason }` when the soft size guard would be exceeded,
 * otherwise `{ ok: true }`.
 */
export function upsertMemoryEntry(
	baseDir: string,
	cwd: string,
	entry: Omit<MemoryEntry, "updatedAt"> & { detail?: string },
): { ok: true } | { ok: false; reason: string } {
	const entries = loadMemoryIndex(baseDir, cwd);
	const slug = slugify(entry.topic);
	const updatedAt = new Date().toISOString();
	const summary = entry.summary.trim().slice(0, MEMORY_SUMMARY_MAX_LENGTH);

	const existingIndex = entries.findIndex((e) => slugify(e.topic) === slug);
	const newEntry: MemoryEntry = {
		topic: entry.topic.trim() || slug,
		summary,
		type: entry.type,
		updatedAt,
	};

	if (existingIndex >= 0) {
		entries[existingIndex] = newEntry;
	} else {
		entries.push(newEntry);
	}

	const dir = memoryDirForCwd(baseDir, cwd);
	ensureDir(dir);
	ensureDir(join(dir, MEMORY_NOTES_DIR));

	const indexContent = serializeIndexEntries(entries);
	const projectedLines = indexContent.split("\n").length;
	const projectedBytes = Buffer.byteLength(indexContent, "utf-8");

	if (projectedLines > MEMORY_INDEX_SOFT_LINE_LIMIT) {
		return {
			ok: false,
			reason: `Memory index would reach ${projectedLines} lines (soft limit ${MEMORY_INDEX_SOFT_LINE_LIMIT}). Consolidate or remove older topics before adding more.`,
		};
	}
	if (projectedBytes > MEMORY_INDEX_SOFT_SIZE_LIMIT) {
		return {
			ok: false,
			reason: `Memory index would reach ${projectedBytes} bytes (soft limit ${MEMORY_INDEX_SOFT_SIZE_LIMIT}). Consolidate or remove older topics before adding more.`,
		};
	}

	writeFileSync(memoryIndexPath(baseDir, cwd), indexContent, "utf-8");

	if (entry.detail?.trim()) {
		writeFileSync(memoryNotePath(baseDir, cwd, entry.topic), entry.detail.trim(), "utf-8");
	}

	return { ok: true };
}

/** Read a detail note. Returns `null` when absent. */
export function loadMemoryNote(baseDir: string, cwd: string, topic: string): string | null {
	const fp = memoryNotePath(baseDir, cwd, topic);
	if (!existsSync(fp)) return null;
	try {
		return readFileSync(fp, "utf-8");
	} catch {
		return null;
	}
}

/** Overwrite or create a detail note directly. */
export function saveMemoryNote(baseDir: string, cwd: string, topic: string, content: string): void {
	ensureDir(memoryDirForCwd(baseDir, cwd));
	ensureDir(join(memoryDirForCwd(baseDir, cwd), MEMORY_NOTES_DIR));
	writeFileSync(memoryNotePath(baseDir, cwd, topic), content, "utf-8");
}

/**
 * Remove a topic from the index, delete its detail note, and clean up empty
 * directories. Returns true if a topic was removed.
 */
export function deleteMemoryTopic(baseDir: string, cwd: string, topic: string): boolean {
	const entries = loadMemoryIndex(baseDir, cwd);
	const slug = slugify(topic);
	const next = entries.filter((e) => slugify(e.topic) !== slug);
	if (next.length === entries.length) return false;

	const dir = memoryDirForCwd(baseDir, cwd);
	ensureDir(dir);
	writeFileSync(memoryIndexPath(baseDir, cwd), serializeIndexEntries(next), "utf-8");

	const notePath = memoryNotePath(baseDir, cwd, topic);
	if (existsSync(notePath)) {
		rmSync(notePath);
	}

	// Clean up empty notes dir.
	const notesDir = join(dir, MEMORY_NOTES_DIR);
	try {
		if (existsSync(notesDir) && readdirSync(notesDir).length === 0) {
			rmSync(notesDir, { recursive: true });
		}
	} catch {
		// best-effort cleanup only
	}

	return true;
}

/**
 * Render the system-prompt block for project memory, or an empty string when
 * none exists. Mirrors `customInstructionsBlock` in style.
 */
export function memoryIndexBlock(baseDir: string, cwd: string): string {
	const entries = loadMemoryIndex(baseDir, cwd);
	if (entries.length === 0) return "";

	const lines = [
		"## Project memory",
		"",
		"The following facts have been remembered about this workspace. They persist across sessions; details live in `notes/<topic>.md` and can be read with the read tool when needed.",
		"",
	];
	for (const entry of entries) {
		const typePrefix = entry.type ? `[${entry.type}] ` : "";
		lines.push(`- **${entry.topic}** — ${typePrefix}${entry.summary}`);
	}
	lines.push("");
	return lines.join("\n");
}
