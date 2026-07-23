/**
 * Hypatia Cowork — Agent Initialization
 *
 * Bootstraps the pi-coding-agent SDK: creates ModelRuntime, ModelRegistry,
 * SettingsManager, ResourceLoader, and the agent session. Also handles
 * directory resolution, session persistence, and settings management.
 *
 * This module is the "pure init" layer — it creates the core infrastructure
 * but leaves event subscription, pi-routines wiring, and the `ready` event
 * emission to the caller (main() in index.ts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { log } from "./protocol.js";
import { coworkSelfKnowledgePointer, writeAboutDoc } from "./about-cowork.js";
import { loadInstructions, customInstructionsBlock } from "./instructions-store.js";
import { memoryIndexBlock } from "./memory-store.js";
import { loadSettings as loadSettingsStore, saveSettings as saveSettingsStore } from "./settings-store.js";
// import { readPiPackages, buildExtensionFactories } from "./disk-extension-loader.js";

// Vendored extension: the Anthropic messages protocol bridge (no user-facing
// tools; only rewrites tool names for Claude-model API compatibility).
import piAnthropicMessages from "./vendor/anthropic-messages/extensions/index.js";
// First-party extension: lets the agent deliberately render something in
// the playground side panel (see extensions/show-artifact.ts).
import showArtifactExtension from "./extensions/show-artifact.js";
import saveMemoryExtension from "./extensions/save-memory.js";
import findSkillExtension from "./extensions/find-skill.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const PROVIDER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Hypatia Cowork system prompt. Replaces pi-coding-agent's default
 * "You are an expert coding assistant operating inside pi…" preamble.
 */
export const HYPATIA_SYSTEM_PROMPT = `You are Hypatia Cowork, a desktop AI coworker. You help users with their projects by reading files, running shell commands, editing code, and writing new files via your tools.

Identity: if the user asks who or what you are, always answer "Hypatia Cowork". Some upstream APIs may transport-identify this client as "Claude Code" or "pi" for compatibility — that is not your user-facing identity.

Guidelines:
- Be concise.
- Show file paths clearly when working with files.
- Prefer your built-in tools over shelling out when both work.
- When something would help a future session — a decision, a preference, a recurring convention, or a codebase fact — call the save_memory tool to persist it across sessions.
- When a rendered preview (an HTML/SVG page, a formatted document, a code file, or a diff summarizing a multi-file change) would be clearer than describing it in text, call the show_artifact tool. Reuse the same id when updating something you already showed.
- If a task might match a specialized skill and the skills listed below don't make it obvious, call find_skill with a short description of the task to search the full skill library.
- When greeting a user, do not list all your capabilities. Simply ask what they are working on.`;

// ── Directory helpers ──────────────────────────────────────────────────────

export function piAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function defaultHypatiaDir(): string {
	return join(homedir(), ".hypatiai");
}

export function hypatiaAgentDir(hypatiaDir: string): string {
	return join(hypatiaDir, "cowork");
}

export function coworkDefaultHome(): string {
	// Default cwd is the user's home, matching how `pi` opens: run from home →
	// cwd is home. No bespoke HypatiaCowork folder.
	return homedir();
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export function cleanStaleLocks(dir: string): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if (entry.endsWith(".lock")) {
			const lockPath = join(dir, entry);
			try {
				unlinkSync(lockPath);
				log("Cleaned stale lock: %s", entry);
			} catch {
				// ignore if another process holds it
			}
		}
	}
}

// ── Workspace resolution ───────────────────────────────────────────────────

export function defaultWorkspaceDir(hypatiaDir: string): string {
	const configured = loadSettingsStore(hypatiaAgentDir(hypatiaDir)).coworkHomeDir;
	let target =
		typeof configured === "string" && configured.trim() ? configured.trim() : coworkDefaultHome();
	if (target === "~") {
		target = homedir();
	} else if (target.startsWith("~/") || target.startsWith("~\\")) {
		target = join(homedir(), target.slice(2));
	}
	return target;
}

export function resolveWorkspace(requested: string | undefined, hypatiaDir: string): string {
	let target = requested?.trim() ? requested.trim() : defaultWorkspaceDir(hypatiaDir);
	if (target === "~") {
		target = homedir();
	} else if (target.startsWith("~/") || target.startsWith("~\\")) {
		target = join(homedir(), target.slice(2));
	}
	try {
		ensureDir(target);
		if (!statSync(target).isDirectory()) {
			throw new Error("not a directory");
		}
		return target;
	} catch (err) {
		log(
			"workspace resolve failed for %s: %s — falling back to default",
			target,
			err instanceof Error ? err.message : String(err),
		);
		const fallback = defaultWorkspaceDir(hypatiaDir);
		ensureDir(fallback);
		return fallback;
	}
}

// ── Settings persistence ───────────────────────────────────────────────────

export function loadSettings(hypatiaDir: string): Record<string, unknown> {
	return loadSettingsStore(hypatiaAgentDir(hypatiaDir));
}

export function saveSettingsAtDir(hypatiaDir: string, settings: Record<string, unknown>): void {
	saveSettingsStore(hypatiaAgentDir(hypatiaDir), settings);
	log("Settings saved");
}

// ── Resource Loader Builder ────────────────────────────────────────────────

export async function buildResourceLoader(
	workspaceCwd: string,
	hypatiaDir: string,
	settingsManager: ReturnType<typeof SettingsManager.inMemory>,
	opts: { includePersona?: boolean } = {},
): Promise<DefaultResourceLoader> {
	if (!settingsManager) {
		throw new Error("buildResourceLoader: settingsManager not initialized");
	}
	const includePersona = opts.includePersona ?? true;
	const piResourceDir = piAgentDir();
	ensureDir(piResourceDir);

	// Extensions + skills load pi-native from the shared agentDir (~/.pi/agent):
	// pi's `settings.json` packages and on-disk resources. `extensionFactories`
	// below adds cowork's own programmatic extensions on top.
	const diskExtensionFactories: ExtensionFactory[] = [];

	const loader = new DefaultResourceLoader({
		cwd: workspaceCwd,
		agentDir: piResourceDir,
		settingsManager,
		extensionFactories: [
			piAnthropicMessages,
			showArtifactExtension,
			(pi: ExtensionAPI) => saveMemoryExtension(pi, { baseDir: hypatiaAgentDir(hypatiaDir), workspaceCwd }),
			(pi: ExtensionAPI) => findSkillExtension(pi, { agentDir: piResourceDir, workspaceCwd }),
		],
		systemPromptOverride: () => {
			let personaBlock = "";
			if (includePersona) {
				try {
					personaBlock = customInstructionsBlock(
						loadInstructions(hypatiaAgentDir(hypatiaDir)),
					);
				} catch (err) {
					log(
						"loadInstructions failed (custom instructions omitted): %s",
						err instanceof Error ? err.message : String(err),
					);
				}
			}
			let memoryBlock = "";
			try {
				memoryBlock = memoryIndexBlock(hypatiaAgentDir(hypatiaDir), workspaceCwd);
			} catch (err) {
				log(
					"memoryIndexBlock failed (project memory omitted): %s",
					err instanceof Error ? err.message : String(err),
				);
			}

			try {
				const aboutPath = writeAboutDoc(hypatiaAgentDir(hypatiaDir));
				let base = `${HYPATIA_SYSTEM_PROMPT}\n\n${coworkSelfKnowledgePointer(aboutPath)}`;
				if (memoryBlock) base += `\n\n${memoryBlock}`;
				if (personaBlock) base += `\n\n${personaBlock}`;
				return base;
			} catch (err) {
				log(
					"writeAboutDoc failed (self-knowledge pointer omitted): %s",
					err instanceof Error ? err.message : String(err),
				);
				let base = personaBlock
					? `${HYPATIA_SYSTEM_PROMPT}\n\n${personaBlock}`
					: HYPATIA_SYSTEM_PROMPT;
				if (memoryBlock) base += `\n\n${memoryBlock}`;
				return base;
			}
		},
		appendSystemPromptOverride: () => [],
	});
	try {
		await loader.reload();
	} catch (err) {
		log(
			"resource reload failed (continuing without npm-sourced resources): %s",
			err instanceof Error ? err.message : String(err),
		);
	}
	try {
		const extResult = loader.getExtensions();
		if (extResult.errors && extResult.errors.length > 0) {
			for (const err of extResult.errors) {
				log("extension load error: %s — %s", err.path, err.error);
			}
		}
		log(
			"extensions loaded: %d (errors: %d)",
			extResult.extensions?.length ?? 0,
			extResult.errors?.length ?? 0,
		);
		for (const ext of extResult.extensions ?? []) {
			log("  - %s", ext.path);
		}
	} catch (err) {
		log("getExtensions failed: %s", err);
	}
	return loader;
}
